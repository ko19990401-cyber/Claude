/**
 * `npm run share`
 *
 * サーバを起動し、Tailscale 経由でスマートフォンから使える状態にするまでを
 * ひとまとめにする。Ctrl+C で両方とも後片付けする。
 *
 * `tailscale serve` は --bg を付けないフォアグラウンド実行にしてある。
 * プロセスを終了すれば公開設定も一緒に消えるので、消し忘れが起きない。
 */
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveTailscaleBin } from '../server/lib/tailscale.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', d: '\x1b[2m', x: '\x1b[0m' };
const ok = (m) => console.log(`${C.g}✔${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const fail = (m) => console.error(`${C.r}✘${C.x} ${m}`);
const note = (m) => console.log(`  ${C.d}${m}${C.x}`);

const INSTALL = {
  darwin: 'brew install --cask tailscale （インストール後、Tailscale.app を一度起動してログインしてください）',
  linux: 'curl -fsSL https://tailscale.com/install.sh | sh',
  win32: 'winget install tailscale.tailscale',
};

// macOS はアプリバンドル内にコマンドがあるため、PATH以外も探す
const BIN = resolveTailscaleBin();

async function tailscale(args, options = {}) {
  return run(BIN, args, { timeout: 10000, ...options });
}

async function main() {
  // --- 1. Tailscale が入っているか ---------------------------------------
  try {
    if (!BIN) throw new Error('not found');
    await tailscale(['version']);
  } catch {
    fail('Tailscale が見つかりません。');
    note(`インストール: ${INSTALL[process.platform] || 'https://tailscale.com/download'}`);
    note('インストール後にもう一度 npm run share を実行してください。');
    process.exit(1);
  }

  // --- 2. ログイン済みか（未ログインなら対話でログインさせる）--------------
  let status = await readStatus();
  if (!status || ['NeedsLogin', 'NoState', 'Stopped'].includes(status.BackendState)) {
    warn('Tailscale にログインしていません。ブラウザで認証します…');
    await new Promise((resolve) => {
      // 認証URLを表示するため、そのまま端末へ出す
      spawn(BIN, ['up'], { stdio: 'inherit' }).on('close', resolve);
    });
    status = await readStatus();
  }

  const dns = String(status?.Self?.DNSName || '').replace(/\.$/, '');
  if (!dns) {
    fail('Tailscale の状態を取得できませんでした。`tailscale status` を確認してください。');
    process.exit(1);
  }
  ok(`Tailscale: ${dns}`);

  // --- 3. アプリサーバを起動 ----------------------------------------------
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    // このスクリプトが公開まで面倒を見るので、サーバ側の案内は抑止する
    env: { ...process.env, PORT: String(PORT), SHARE_MANAGED: '1' },
    stdio: 'inherit',
  });

  let serve = null;
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n公開を終了します…');
    serve?.kill('SIGTERM');   // フォアグラウンドの serve は終了時に設定を戻す
    server.kill('SIGTERM');
    setTimeout(() => process.exit(code), 500);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  server.on('close', (code, signal) => {
    if (shuttingDown || signal) return; // Ctrl+C はプロセスグループ全体に届く
    fail(`サーバが終了しました (code ${code})`);
    shutdown(code ?? 1);
  });

  // --- 4. サーバが応答するまで待つ ----------------------------------------
  if (!(await waitForHealth(PORT))) {
    fail(`サーバが起動しませんでした（ポート ${PORT}）。上のログを確認してください。`);
    shutdown(1);
    return;
  }

  // --- 5. tailnet へ公開（フォアグラウンド）-------------------------------
  serve = spawn(BIN, ['serve', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let serveError = '';
  serve.stderr.on('data', (d) => { serveError += d; });
  serve.stdout.on('data', () => {}); // 「Press Ctrl+C to exit」等は握りつぶす

  serve.on('close', (code, signal) => {
    if (shuttingDown || signal) return; // Ctrl+C で serve も直接終了する
    fail(`tailscale serve が終了しました (code ${code})`);
    if (/https|cert/i.test(serveError)) {
      note('管理コンソールの DNS ページで MagicDNS と HTTPS Certificates を有効にしてください。');
      note('https://login.tailscale.com/admin/dns');
    }
    if (serveError.trim()) note(serveError.trim().split('\n')[0]);
    shutdown(1);
  });

  await new Promise((r) => setTimeout(r, 1200));
  if (shuttingDown) return;

  console.log('');
  ok(`スマホからは  ${C.g}https://${dns}${C.x}`);
  note(`このPCからは  http://localhost:${PORT}`);
  note('Ctrl+C で公開を終了します（tailnet の外からは見えません）');
  console.log('');
}

async function readStatus() {
  try {
    const { stdout } = await tailscale(['status', '--json']);
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function waitForHealth(port, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

main().catch((err) => {
  fail(err.message);
  process.exit(1);
});
