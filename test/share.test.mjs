/**
 * `npm run share` のテスト。
 * 本物の Tailscale が無い環境でも検証できるよう、CLIのスタブをPATHの先頭に置く。
 * 実行: DATA_DIR=./.test-data/share PORT=8795 node test/share.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR);
const PORT = Number(process.env.PORT);

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const { check, finish } = createChecker('npm run share（Tailscale公開）');

/** シナリオごとに tailscale コマンドのスタブを作る */
function makeStub(name, serveBody) {
  const dir = path.join(DATA, 'bin', name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'tailscale');
  fs.writeFileSync(file, `#!/bin/sh
case "$1" in
  version) echo "1.80.0"; exit 0 ;;
  status)  echo '{"BackendState":"Running","Self":{"DNSName":"macbook.tail1234.ts.net.","TailscaleIPs":["100.1.1.1"]}}'; exit 0 ;;
  serve)   ${serveBody} ;;
  *) exit 1 ;;
esac
`);
  fs.chmodSync(file, 0o755);
  return dir;
}

/** share.mjs を起動し、出力を集めて任意の条件で打ち切る */
function runShare({ pathPrefix, timeoutMs = 20000, until }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['tools/share.mjs'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH}` : '/usr/bin:/bin',
        PORT: String(PORT),
        DATA_DIR: path.join(DATA, 'run'),
        ELEVENLABS_API_KEY: 'dummy',
        ANTHROPIC_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const finish = (reason) => {
      clearTimeout(timer);
      child.kill('SIGINT');
      setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ output, reason });
      }, 700);
    };
    const onData = (d) => {
      output += d;
      if (until && until(output)) finish('matched');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', () => { clearTimeout(timer); resolve({ output, reason: 'exited' }); });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
  });
}

// --- 正常系：URLを案内し、Ctrl+Cで後片付けする -----------------------------
const okStub = makeStub('ok', 'echo "Available within your tailnet:"; sleep 300');
const success = await runShare({ pathPrefix: okStub, until: (o) => o.includes('スマホからは') });

check('Tailscale の状態を読み取る', success.output.includes('macbook.tail1234.ts.net'));
check('スマホで開くURLを案内する', /スマホからは\s+\S*https:\/\/macbook\.tail1234\.ts\.net/.test(success.output));
check('サーバも同時に起動する', success.output.includes(`http://localhost:${PORT}`));
check('Ctrl+C で公開を終了する', success.output.includes('公開を終了します'));
check('正常終了時に余計なエラーを出さない',
  !success.output.includes('serve が終了しました') && !success.output.includes('サーバが終了しました'));

// 後片付けができていること（ポートが解放されている）
await new Promise((r) => setTimeout(r, 500));
const stillUp = await fetch(`http://127.0.0.1:${PORT}/api/health`).then(() => true).catch(() => false);
check('終了後にサーバのポートを解放する', stillUp === false);

// --- 異常系：Tailscale が入っていない ---------------------------------------
const missing = await runShare({ pathPrefix: null, timeoutMs: 10000 });
check('Tailscale 未導入なら導入方法を案内して終了する',
  missing.output.includes('Tailscale が見つかりません') && /install/i.test(missing.output));

// --- 異常系：HTTPS証明書が未設定で serve が失敗 -----------------------------
const httpsStub = makeStub('nohttps', 'echo "HTTPS is not enabled on your tailnet" >&2; exit 1');
const httpsFail = await runShare({
  pathPrefix: httpsStub,
  until: (o) => o.includes('admin/dns'),
  timeoutMs: 20000,
});
check('HTTPS未有効なら管理コンソールのURLを案内する',
  httpsFail.output.includes('HTTPS Certificates') && httpsFail.output.includes('login.tailscale.com/admin/dns'));
check('serve の失敗内容をそのまま見せる', httpsFail.output.includes('HTTPS is not enabled'));

process.exit(finish() ? 1 : 0);
