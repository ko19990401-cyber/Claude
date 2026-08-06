/**
 * `npm run setup`
 *
 * 初回セットアップを対話式でまとめて行う。
 *   1. Node.js の確認
 *   2. ffmpeg の導入（必要なら Homebrew も）
 *   3. .env の作成
 *   4. APIキーの入力（取得ページをブラウザで開く）
 *   5. Tailscale の導入（スマホから使う場合）
 *
 * アカウント作成・支払い登録・ブラウザでのログインは代行できないので、
 * そこだけは案内して手を止める。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
const ok = (m) => console.log(`${C.g}✔${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const fail = (m) => console.log(`${C.r}✘${C.x} ${m}`);
const note = (m) => console.log(`  ${C.d}${m}${C.x}`);
const step = (n, title) => console.log(`\n${C.b}[${n}] ${title}${C.x}`);

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let rl = null;
const ask = async (question, fallback = '') => {
  if (!interactive) return fallback;
  rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(question)).trim();
};
const confirm = async (question, fallback = false) => {
  if (!interactive) return fallback;
  const answer = (await ask(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
};

const has = async (command, args = ['--version']) => {
  try {
    await run(command, args, { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
};

/** 子プロセスを端末に繋いだまま実行する（パスワード入力などがあるため） */
const runVisible = (command, args) => new Promise((resolve) => {
  spawn(command, args, { cwd: ROOT, stdio: 'inherit' }).on('close', (code) => resolve(code === 0));
});

const openUrl = async (url) => {
  const opener = { darwin: 'open', win32: 'start', linux: 'xdg-open' }[process.platform];
  if (opener) await run(opener, [url]).catch(() => {});
};

/** .env の該当行だけを差し替える。コメントや他の設定は壊さない。 */
export function upsertEnv(content, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (pattern.test(content)) return content.replace(pattern, line);
  return `${content.trimEnd()}\n${line}\n`;
}

export function readEnvValue(content, key) {
  const match = new RegExp(`^${key}=(.*)$`, 'm').exec(content);
  return match ? match[1].trim() : '';
}

const mask = (value) => (value.length <= 8 ? '****' : `${value.slice(0, 4)}…${value.slice(-4)}`);

const API_KEYS = [
  {
    key: 'ELEVENLABS_API_KEY',
    label: '文字起こし（ElevenLabs Scribe）',
    url: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: '要約（Anthropic Claude）',
    url: 'https://console.anthropic.com/settings/keys',
  },
];

async function main() {
  console.log(`${C.b}音声文字起こし・要約ツール セットアップ${C.x}`);
  if (!interactive) note('非対話モードです。状態の確認のみ行います。');

  // --- 1. Node.js ---------------------------------------------------------
  step(1, 'Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok(`Node.js ${process.versions.node}`);
  else {
    fail(`Node.js ${process.versions.node}（v20以上が必要です）`);
    note('https://nodejs.org から最新版を入れ直してください。');
    return 1;
  }

  // --- 2. ffmpeg ----------------------------------------------------------
  step(2, 'ffmpeg（音声の変換に必須）');
  if (await has('ffmpeg', ['-version'])) {
    ok('ffmpeg は導入済みです');
  } else if (!(await installFfmpeg())) {
    return 1;
  }

  // --- 3. .env ------------------------------------------------------------
  step(3, '設定ファイル（.env）');
  if (!fs.existsSync(ENV_FILE)) {
    fs.copyFileSync(ENV_EXAMPLE, ENV_FILE);
    ok('.env を作成しました');
  } else {
    ok('.env は作成済みです');
  }

  // --- 4. APIキー ---------------------------------------------------------
  step(4, 'APIキー');
  let content = fs.readFileSync(ENV_FILE, 'utf8');
  let missing = 0;

  for (const { key, label, url } of API_KEYS) {
    const current = readEnvValue(content, key);
    if (current) {
      ok(`${label}：設定済み（${mask(current)}）`);
      continue;
    }
    if (!interactive) {
      warn(`${label}：未設定`);
      note(`取得先: ${url}`);
      missing += 1;
      continue;
    }

    console.log(`\n  ${label} のキーが必要です。`);
    note(`取得先: ${url}`);
    if (await confirm('  ブラウザで取得ページを開きますか？')) await openUrl(url);
    console.log(`  ${C.d}※ 入力した文字は画面に表示されます。周囲にご注意ください。${C.x}`);
    const value = await ask('  キーを貼り付けて Enter（あとで設定する場合は空のまま Enter）: ');

    if (!value) {
      warn(`${label}：あとで .env に記入してください`);
      missing += 1;
    } else if (/\s/.test(value)) {
      fail('空白が含まれています。コピー範囲を確認して、もう一度 npm run setup を実行してください。');
      missing += 1;
    } else {
      content = upsertEnv(content, key, value);
      fs.writeFileSync(ENV_FILE, content);
      ok(`${label}：保存しました（${mask(value)}）`);
    }
  }

  // --- 5. Tailscale -------------------------------------------------------
  step(5, 'Tailscale（スマホから使う場合のみ）');
  const { resolveTailscaleBin } = await import('../server/lib/tailscale.js');
  if (resolveTailscaleBin()) {
    ok('Tailscale は導入済みです');
  } else if (interactive && (await confirm('  スマートフォンからも使いますか？'))) {
    await installTailscale();
  } else {
    note('あとで導入する場合は README の §2.5-A を参照してください。');
  }

  // --- まとめ -------------------------------------------------------------
  console.log(`\n${C.b}次にやること${C.x}`);
  if (missing) {
    warn(`APIキーが ${missing} 件未設定です。.env に記入してから起動してください。`);
    note(`設定ファイル: ${ENV_FILE}`);
  }
  console.log(`  ${C.g}npm run dev${C.x}    このPCのブラウザで使う`);
  console.log(`  ${C.g}npm run share${C.x}  スマホからも使う（Tailscale経由）`);
  console.log(`  ${C.g}npm run doctor${C.x} 設定を確認し直す\n`);
  return 0;
}

async function installFfmpeg() {
  if (process.platform === 'darwin') {
    if (!(await has('brew'))) {
      warn('Homebrew が入っていません（ffmpeg の導入に使います）');
      note('Homebrew は macOS にソフトを入れるための道具です。');
      note('インストール中に Mac のパスワードを聞かれます（入力しても画面には表示されません）。');
      if (!(await confirm('  Homebrew をインストールしますか？'))) {
        note('後で手動で入れる場合: https://brew.sh');
        return false;
      }
      const script = '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';
      if (!(await runVisible('/bin/bash', ['-c', script]))) {
        fail('Homebrew のインストールに失敗しました。');
        return false;
      }
      // インストール直後は PATH に載っていないことがある
      for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
        if (fs.existsSync(path.join(dir, 'brew'))) process.env.PATH = `${dir}:${process.env.PATH}`;
      }
    }
    console.log('  ffmpeg を導入します（数分かかります）…');
    if (await runVisible('brew', ['install', 'ffmpeg'])) {
      ok('ffmpeg を導入しました');
      return true;
    }
    fail('ffmpeg の導入に失敗しました。上のメッセージを確認してください。');
    return false;
  }

  const command = {
    linux: 'sudo apt install -y ffmpeg',
    win32: 'winget install Gyan.FFmpeg',
  }[process.platform];
  fail('ffmpeg が見つかりません。');
  note(`次のコマンドで導入してください: ${command || 'https://ffmpeg.org/download.html'}`);
  note('導入後にもう一度 npm run setup を実行してください。');
  return false;
}

async function installTailscale() {
  if (process.platform !== 'darwin') {
    note('導入方法: https://tailscale.com/download');
    return;
  }
  if (!(await has('brew'))) {
    note('導入方法: https://tailscale.com/download');
    return;
  }
  if (await runVisible('brew', ['install', '--cask', 'tailscale'])) {
    ok('Tailscale を導入しました');
    note('このあと Tailscale.app を起動してログインしてください（無料アカウントで可）。');
    note('スマホにも同じアカウントで Tailscale アプリを入れてください。');
    if (await confirm('  Tailscale.app を起動しますか？')) {
      await run('open', ['-a', 'Tailscale']).catch(() => {});
    }
  } else {
    note('導入方法: https://tailscale.com/download');
  }
}

// テストから upsertEnv などを import しても実行されないようにする
const isEntryPoint = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const code = await main().catch((err) => {
    fail(err.message);
    return 1;
  });
  rl?.close();
  process.exit(code);
}
