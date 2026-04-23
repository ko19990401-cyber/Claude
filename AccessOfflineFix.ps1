#Requires -RunAsAdministrator
<#
.SYNOPSIS
    LGWAN環境における Microsoft Access (Microsoft 365 Runtime) 起動フリーズ対策スクリプト

.DESCRIPTION
    MSACCESS.EXE 起動時にインターネット接続タイムアウトで発生するフリーズを解消する。
    以下の処置を一括実施する：
      1. Windowsファイアウォール アウトバウンドブロックルール追加
      2. hostsファイルへの Microsoft 365 ドメイン ブロックエントリ追加
      3. レジストリによるテレメトリ・自動更新の無効化
      4. ClickToRunSvc サービスの停止・無効化
    実行後、ロールバックスクリプト (Rollback_AccessOfflineFix.ps1) を同フォルダに生成する。

.NOTES
    実行要件 : Windows 10 / Windows 11、PowerShell 5.1以上、管理者権限
    対象製品 : Microsoft 365 Access Runtime (Office 16.0系)

    ─── GPO による一括展開方法 ────────────────────────────────────────────────
    [手順]
    1. このスクリプトをネットワーク共有 (例: \\fileserver\GPO\Scripts\) に配置する。
    2. グループポリシー管理エディターを開く。
    3. [コンピューターの構成] → [Windowsの設定] → [スクリプト(スタートアップ/シャットダウン)]
       → [スタートアップ] を右クリック → [プロパティ]。
    4. [PowerShell スクリプト] タブ → [追加] → スクリプト名に UNC パスを入力。
    5. スクリプトパラメーターに何も指定しない（管理者コンテキストで実行される）。
    6. [コンピューターの構成] → [管理用テンプレート] → [システム] → [スクリプト] で
       「スタートアップ/シャットダウン スクリプトを非同期で実行する」を「無効」に設定
       （スクリプト完了後にログオンさせるため）。
    7. PowerShell 実行ポリシーを GPO で緩和する場合は
       [コンピューターの構成] → [管理用テンプレート] → [Windowsコンポーネント]
       → [Windows PowerShell] → 「スクリプトの実行を有効にする」→
       「署名されたスクリプトのみ許可」または「すべてのスクリプトを許可」を選択。
    ─────────────────────────────────────────────────────────────────────────────
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ─── 定数 ─────────────────────────────────────────────────────────────────────
$LOG_DIR        = 'C:\Logs'
$LOG_FILE       = Join-Path $LOG_DIR 'AccessOfflineFix_log.txt'
$ROLLBACK_FILE  = Join-Path $PSScriptRoot 'Rollback_AccessOfflineFix.ps1'
$HOSTS_FILE     = "$env:SystemRoot\System32\drivers\etc\hosts"
$HOSTS_MARKER   = '# AccessOfflineFix BEGIN'
$HOSTS_MARKER_END = '# AccessOfflineFix END'

$FW_RULES = @(
    @{ Name = 'Block-MSACCESS-Outbound';          Program = '%ProgramFiles%\Microsoft Office\root\Office16\MSACCESS.EXE' }
    @{ Name = 'Block-OfficeClickToRun-Outbound';   Program = '%CommonProgramFiles%\microsoft shared\ClickToRun\OfficeClickToRun.exe' }
    @{ Name = 'Block-OfficeC2RClient-Outbound';    Program = '%CommonProgramFiles%\microsoft shared\ClickToRun\OfficeC2RClient.exe' }
)

$BLOCK_DOMAINS = @(
    'licensing.mp.microsoft.com'
    'office15client.microsoft.com'
    'officeclient.microsoft.com'
    'watson.telemetry.microsoft.com'
    'sqm.telemetry.microsoft.com'
    'ecs.office.com'
    'otelrules.azureedge.net'
    'config.edge.skype.com'
)

# ─── ログ関数 ─────────────────────────────────────────────────────────────────
function Write-Log {
    param(
        [string]$Message,
        [ValidateSet('Info','Success','Warning','Error')]
        [string]$Level = 'Info'
    )
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts][$Level] $Message"

    $color = switch ($Level) {
        'Success' { 'Green'  }
        'Warning' { 'Yellow' }
        'Error'   { 'Red'    }
        default   { 'Cyan'   }
    }
    Write-Host $line -ForegroundColor $color

    if (-not (Test-Path $LOG_DIR)) {
        New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
    }
    Add-Content -Path $LOG_FILE -Value $line -Encoding UTF8
}

function Write-Section {
    param([string]$Title)
    $sep = '─' * 60
    Write-Log $sep
    Write-Log "  $Title"
    Write-Log $sep
}

# ─── Step 1: Windowsファイアウォール ──────────────────────────────────────────
function Set-FirewallRules {
    Write-Section 'Step 1: Windowsファイアウォール アウトバウンドブロックルール追加'

    foreach ($rule in $FW_RULES) {
        try {
            $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
            if ($existing) {
                Write-Log "スキップ (既存): $($rule.Name)" -Level Warning
                continue
            }

            # %変数% を実際のパスに展開してからルール登録
            $expandedPath = [System.Environment]::ExpandEnvironmentVariables($rule.Program)

            New-NetFirewallRule `
                -DisplayName  $rule.Name `
                -Direction    Outbound `
                -Action       Block `
                -Program      $expandedPath `
                -Profile      Any `
                -Enabled      True `
                -Description  'AccessOfflineFix: LGWAN環境向けアウトバウンドブロック' `
                | Out-Null

            Write-Log "追加成功: $($rule.Name)  →  $expandedPath" -Level Success
        }
        catch {
            Write-Log "追加失敗: $($rule.Name) — $($_.Exception.Message)" -Level Error
        }
    }
}

# ─── Step 2: hostsファイル ────────────────────────────────────────────────────
function Set-HostsEntries {
    Write-Section 'Step 2: hostsファイル ドメインブロックエントリ追加'

    $content = Get-Content $HOSTS_FILE -Encoding UTF8 -Raw

    if ($content -match [regex]::Escape($HOSTS_MARKER)) {
        Write-Log 'hostsエントリは既に存在します。スキップします。' -Level Warning
        return
    }

    $newLines  = "`r`n$HOSTS_MARKER`r`n"
    $newLines += ($BLOCK_DOMAINS | ForEach-Object { "0.0.0.0  $_" }) -join "`r`n"
    $newLines += "`r`n$HOSTS_MARKER_END`r`n"

    try {
        # hostsファイルのバックアップ
        $backupPath = "$HOSTS_FILE.bak_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
        Copy-Item $HOSTS_FILE $backupPath -Force
        Write-Log "hostsバックアップ作成: $backupPath" -Level Info

        Add-Content -Path $HOSTS_FILE -Value $newLines -Encoding UTF8
        Write-Log "hostsエントリ追加成功 ($($BLOCK_DOMAINS.Count) ドメイン)" -Level Success

        # DNSキャッシュクリア
        ipconfig /flushdns | Out-Null
        Write-Log 'DNSキャッシュをクリアしました。' -Level Info
    }
    catch {
        Write-Log "hostsファイル書き込み失敗: $($_.Exception.Message)" -Level Error
    }
}

# ─── Step 3: レジストリ設定 ───────────────────────────────────────────────────
function Set-RegistrySettings {
    Write-Section 'Step 3: レジストリ テレメトリ・自動更新の無効化'

    $regSettings = @(
        @{
            Path  = 'HKCU:\Software\Microsoft\Office\16.0\Common\Telemetry'
            Name  = 'DisableTelemetry'
            Value = 1
            Type  = 'DWord'
            Desc  = 'Office テレメトリ無効化 (HKCU)'
        }
        @{
            Path  = 'HKLM:\SOFTWARE\Policies\Microsoft\Office\16.0\Common\OfficeUpdate'
            Name  = 'EnableAutomaticUpdates'
            Value = 0
            Type  = 'DWord'
            Desc  = 'Office 自動更新の無効化'
        }
        @{
            Path  = 'HKLM:\SOFTWARE\Policies\Microsoft\Office\16.0\Common\OfficeUpdate'
            Name  = 'HideUpdateNotifications'
            Value = 1
            Type  = 'DWord'
            Desc  = '更新通知の非表示'
        }
    )

    foreach ($setting in $regSettings) {
        try {
            if (-not (Test-Path $setting.Path)) {
                New-Item -Path $setting.Path -Force | Out-Null
            }
            Set-ItemProperty -Path $setting.Path -Name $setting.Name -Value $setting.Value -Type $setting.Type
            Write-Log "設定成功: $($setting.Desc)  [$($setting.Path)\$($setting.Name) = $($setting.Value)]" -Level Success
        }
        catch {
            Write-Log "設定失敗: $($setting.Desc) — $($_.Exception.Message)" -Level Error
        }
    }
}

# ─── Step 4: ClickToRunSvc サービス ──────────────────────────────────────────
function Disable-ClickToRunService {
    Write-Section 'Step 4: ClickToRunSvc サービスの停止・無効化'

    $svcName = 'ClickToRunSvc'
    try {
        $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Write-Log "サービス '$svcName' は存在しません。スキップします。" -Level Warning
            return
        }

        if ($svc.Status -eq 'Running') {
            Stop-Service -Name $svcName -Force
            Write-Log "サービス停止: $svcName" -Level Success
        }
        else {
            Write-Log "サービスはすでに停止状態です: $svcName" -Level Info
        }

        Set-Service -Name $svcName -StartupType Disabled
        Write-Log "スタートアップを [無効] に変更: $svcName" -Level Success
    }
    catch {
        Write-Log "サービス操作失敗: $svcName — $($_.Exception.Message)" -Level Error
    }
}

# ─── Step 5: ロールバックスクリプト生成 ──────────────────────────────────────
function New-RollbackScript {
    Write-Section 'Step 5: ロールバックスクリプトの生成'

    $fwRuleNames    = ($FW_RULES | ForEach-Object { "'$($_.Name)'" }) -join ', '
    $hostsMarker    = $HOSTS_MARKER
    $hostsMarkerEnd = $HOSTS_MARKER_END

    $rollbackContent = @"
#Requires -RunAsAdministrator
<#
.SYNOPSIS
    AccessOfflineFix.ps1 による変更をすべて元に戻すロールバックスクリプト
.NOTES
    生成日時: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    元スクリプト: AccessOfflineFix.ps1
#>

Set-StrictMode -Version Latest
`$ErrorActionPreference = 'Continue'

`$LOG_DIR  = 'C:\Logs'
`$LOG_FILE = Join-Path `$LOG_DIR 'AccessOfflineFix_rollback_log.txt'

function Write-Log {
    param([string]`$Message, [string]`$Level = 'Info')
    `$ts   = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    `$line = "[`$ts][`$Level] `$Message"
    `$color = switch (`$Level) { 'Success'{'Green'} 'Warning'{'Yellow'} 'Error'{'Red'} default{'Cyan'} }
    Write-Host `$line -ForegroundColor `$color
    if (-not (Test-Path `$LOG_DIR)) { New-Item -ItemType Directory -Path `$LOG_DIR -Force | Out-Null }
    Add-Content -Path `$LOG_FILE -Value `$line -Encoding UTF8
}

Write-Log '==== AccessOfflineFix ロールバック開始 ====' -Level Info

# ─── 1. ファイアウォールルール削除 ─────────────────────────────────────────────
Write-Log '--- Step 1: ファイアウォールルール削除'
`$ruleNames = @($fwRuleNames)
foreach (`$name in `$ruleNames) {
    try {
        `$r = Get-NetFirewallRule -DisplayName `$name -ErrorAction SilentlyContinue
        if (`$r) {
            Remove-NetFirewallRule -DisplayName `$name
            Write-Log "削除成功: `$name" -Level Success
        } else {
            Write-Log "ルールが存在しません: `$name" -Level Warning
        }
    } catch {
        Write-Log "削除失敗: `$name — `$(`$_.Exception.Message)" -Level Error
    }
}

# ─── 2. hostsエントリ削除 ──────────────────────────────────────────────────────
Write-Log '--- Step 2: hostsファイル エントリ削除'
try {
    `$hostsPath = "`$env:SystemRoot\System32\drivers\etc\hosts"
    `$lines     = Get-Content `$hostsPath -Encoding UTF8
    `$inside    = `$false
    `$filtered  = foreach (`$line in `$lines) {
        if (`$line -match [regex]::Escape('$hostsMarker'))    { `$inside = `$true;  continue }
        if (`$line -match [regex]::Escape('$hostsMarkerEnd')) { `$inside = `$false; continue }
        if (-not `$inside) { `$line }
    }
    `$filtered | Set-Content `$hostsPath -Encoding UTF8
    ipconfig /flushdns | Out-Null
    Write-Log 'hostsエントリ削除成功。DNSキャッシュをクリアしました。' -Level Success
} catch {
    Write-Log "hostsファイル操作失敗: `$(`$_.Exception.Message)" -Level Error
}

# ─── 3. レジストリ設定の削除 ──────────────────────────────────────────────────
Write-Log '--- Step 3: レジストリ設定削除'

# テレメトリ値 (HKCU)
try {
    `$path = 'HKCU:\Software\Microsoft\Office\16.0\Common\Telemetry'
    if (Test-Path `$path) {
        Remove-ItemProperty -Path `$path -Name 'DisableTelemetry' -ErrorAction SilentlyContinue
        Write-Log "削除成功: DisableTelemetry (HKCU)" -Level Success
    }
} catch {
    Write-Log "削除失敗: DisableTelemetry — `$(`$_.Exception.Message)" -Level Error
}

# OfficeUpdate ポリシーキーごと削除 (他に値がなければ)
try {
    `$path = 'HKLM:\SOFTWARE\Policies\Microsoft\Office\16.0\Common\OfficeUpdate'
    if (Test-Path `$path) {
        Remove-Item -Path `$path -Recurse -Force
        Write-Log "削除成功: OfficeUpdate ポリシーキー (HKLM)" -Level Success
    }
} catch {
    Write-Log "削除失敗: OfficeUpdate ポリシーキー — `$(`$_.Exception.Message)" -Level Error
}

# ─── 4. ClickToRunSvc サービス再有効化 ────────────────────────────────────────
Write-Log '--- Step 4: ClickToRunSvc サービス再有効化'
try {
    `$svc = Get-Service -Name 'ClickToRunSvc' -ErrorAction SilentlyContinue
    if (`$svc) {
        Set-Service  -Name 'ClickToRunSvc' -StartupType Automatic
        Start-Service -Name 'ClickToRunSvc' -ErrorAction SilentlyContinue
        Write-Log 'ClickToRunSvc を自動起動に戻し、開始しました。' -Level Success
    } else {
        Write-Log 'ClickToRunSvc が見つかりません。スキップします。' -Level Warning
    }
} catch {
    Write-Log "ClickToRunSvc 再有効化失敗: `$(`$_.Exception.Message)" -Level Error
}

Write-Log '==== ロールバック完了 ====' -Level Success
Write-Log "ログ: `$LOG_FILE" -Level Info
"@

    try {
        $rollbackContent | Set-Content -Path $ROLLBACK_FILE -Encoding UTF8
        Write-Log "ロールバックスクリプト生成成功: $ROLLBACK_FILE" -Level Success
    }
    catch {
        Write-Log "ロールバックスクリプト生成失敗: $($_.Exception.Message)" -Level Error
    }
}

# ─── メイン実行 ───────────────────────────────────────────────────────────────
function Main {
    Write-Log '════════════════════════════════════════════════════════════'
    Write-Log '  AccessOfflineFix.ps1  —  LGWAN環境 Access 起動フリーズ対策'
    Write-Log "  実行日時: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
    Write-Log "  実行ユーザー: $env:USERDOMAIN\$env:USERNAME"
    Write-Log '════════════════════════════════════════════════════════════'

    Set-FirewallRules
    Set-HostsEntries
    Set-RegistrySettings
    Disable-ClickToRunService
    New-RollbackScript

    Write-Log '════════════════════════════════════════════════════════════'
    Write-Log '  すべての処理が完了しました。' -Level Success
    Write-Log "  実行ログ      : $LOG_FILE"
    Write-Log "  ロールバック  : $ROLLBACK_FILE"
    Write-Log '  変更を有効にするため、PCを再起動してください。' -Level Warning
    Write-Log '════════════════════════════════════════════════════════════'
}

Main
