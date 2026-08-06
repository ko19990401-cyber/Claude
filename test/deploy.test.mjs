/**
 * 公開配置まわりのテスト。
 * Basic認証がAPI・静的ファイル・SSE・音声配信すべてに掛かること、
 * ヘルスチェックだけは認証なしで通ること、
 * REQUIRE_AUTH が有効なのに認証未設定なら起動しないことを確認する。
 * 実行: DATA_DIR=./.test-data/deploy PORT=8794 node test/deploy.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR);
const PORT = Number(process.env.PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const USER = 'kamikawa';
const PASSWORD = 'secret-passphrase';
const CREDENTIAL = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString('base64')}`;

fs.rmSync(DATA, { recursive: true, force: true });

const { check, finish } = createChecker('公開配置（認証・ヘルスチェック）');

function startServer(env, { expectExit = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    if (expectExit) {
      child.on('close', (code) => resolve({ child, code, output }));
    } else {
      setTimeout(() => resolve({ child, code: null, output }), 1500);
    }
  });
}

// --- 認証を有効にして起動 ---------------------------------------------------
const running = await startServer({
  AUTH_USER: USER,
  AUTH_PASSWORD: PASSWORD,
  HOST: '127.0.0.1',
  ELEVENLABS_API_KEY: 'dummy',
});

try {
  const health = await fetch(`${BASE}/api/health`);
  check('ヘルスチェックは認証なしで通る', health.status === 200, `HTTP ${health.status}`);
  check('ヘルスチェックの内容', (await health.json()).ok === true);

  for (const [label, url] of [
    ['画面（/）', '/'],
    ['静的ファイル（/styles.css）', '/styles.css'],
    ['API（/api/system）', '/api/system'],
    ['ジョブ一覧', '/api/jobs'],
  ]) {
    const res = await fetch(`${BASE}${url}`);
    check(`認証なしでは拒否：${label}`, res.status === 401, `HTTP ${res.status}`);
  }

  const withAuth = await fetch(`${BASE}/api/system`, { headers: { authorization: CREDENTIAL } });
  check('正しい資格情報なら通る', withAuth.status === 200, `HTTP ${withAuth.status}`);

  const wrong = await fetch(`${BASE}/api/system`, {
    headers: { authorization: `Basic ${Buffer.from(`${USER}:wrong`).toString('base64')}` },
  });
  check('誤ったパスワードは拒否', wrong.status === 401, `HTTP ${wrong.status}`);

  check('WWW-Authenticate ヘッダを返す（ブラウザが認証ダイアログを出せる）',
    /^Basic/i.test((await fetch(`${BASE}/`)).headers.get('www-authenticate') || ''));

  // EventSource も <audio> もヘッダを付けられないが、Basic認証はブラウザが
  // 自動付与するので実運用では通る。ここではサーバ側が保護していることを確認する。
  const sse = await fetch(`${BASE}/api/jobs/job_dummy/events`);
  check('SSEエンドポイントも保護される', sse.status === 401, `HTTP ${sse.status}`);
  const audio = await fetch(`${BASE}/api/jobs/job_dummy/audio`);
  check('音声配信も保護される', audio.status === 401, `HTTP ${audio.status}`);

  // 認証を通したうえで存在しないジョブは404になる（認証と存在確認の順序）
  const missing = await fetch(`${BASE}/api/jobs/job_dummy`, { headers: { authorization: CREDENTIAL } });
  check('認証後は通常どおり404を返す', missing.status === 404, `HTTP ${missing.status}`);

  const manifest = await fetch(`${BASE}/manifest.webmanifest`, { headers: { authorization: CREDENTIAL } });
  const manifestJson = await manifest.json();
  check('PWAマニフェストを配信', manifest.ok && manifestJson.icons.length >= 2, `${manifestJson.name}`);

  for (const icon of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png']) {
    const res = await fetch(`${BASE}${icon}`, { headers: { authorization: CREDENTIAL } });
    const head = Buffer.from(await res.arrayBuffer()).subarray(1, 4).toString('ascii');
    check(`アイコンを配信：${icon}`, res.ok && head === 'PNG');
  }
} finally {
  running.child.kill();
  await new Promise((r) => setTimeout(r, 300));
}

// --- REQUIRE_AUTH が有効で認証未設定なら起動しない --------------------------
const refused = await startServer({
  REQUIRE_AUTH: 'true',
  AUTH_USER: '',
  AUTH_PASSWORD: '',
  PORT: String(PORT + 1),
}, { expectExit: true });
check('REQUIRE_AUTH 有効かつ認証未設定なら起動を拒否',
  refused.code === 1 && /AUTH_USER/.test(refused.output), `exit=${refused.code}`);

// --- 認証なし・ローカル待受なら従来どおり起動する ---------------------------
const local = await startServer({
  AUTH_USER: '',
  AUTH_PASSWORD: '',
  REQUIRE_AUTH: '',
  PORT: String(PORT + 2),
  ELEVENLABS_API_KEY: 'dummy',
});
try {
  const res = await fetch(`http://127.0.0.1:${PORT + 2}/api/system`);
  check('ローカル利用では認証なしでそのまま使える', res.status === 200, `HTTP ${res.status}`);
} finally {
  local.child.kill();
}

// --- Tailscale 検出（スマホからのアクセス案内）------------------------------
// 本物の tailscale が無い環境でも検証できるよう、スタブをPATHの先頭に置く。
const stubDir = path.join(DATA, 'bin');
fs.mkdirSync(stubDir, { recursive: true });
const stub = path.join(stubDir, 'tailscale');
fs.writeFileSync(stub, `#!/bin/sh
if [ "$1" = "status" ]; then
  echo '{"Self":{"DNSName":"macbook.tail1234.ts.net.","TailscaleIPs":["100.101.102.103"]}}'
  exit 0
fi
if [ "$1" = "serve" ]; then
  if [ -n "$STUB_SERVE" ]; then
    echo "https://macbook.tail1234.ts.net (tailnet only)"
    echo "|-- / proxy http://127.0.0.1:${PORT}"
    exit 0
  fi
  echo "No serve config" >&2
  exit 1
fi
exit 1
`);
fs.chmodSync(stub, 0o755);

const { detectTailnet } = await import('../server/lib/tailscale.js');
const originalPath = process.env.PATH;
process.env.PATH = `${stubDir}:${originalPath}`;

try {
  delete process.env.STUB_SERVE;
  const notServed = await detectTailnet(PORT);
  check('Tailscale を検出しつつ serve 未設定を見分ける',
    notServed?.dns === 'macbook.tail1234.ts.net' && notServed.served === false && notServed.url === null,
    notServed?.dns);

  process.env.STUB_SERVE = '1';
  const served = await detectTailnet(PORT);
  check('tailscale serve 設定済みならHTTPSのURLを割り出す',
    served?.served === true && served.url === 'https://macbook.tail1234.ts.net', served?.url);

  // ポートが違えば自分の serve ではない
  const otherPort = await detectTailnet(PORT + 100);
  check('別ポートの serve 設定は自分のものと誤認しない', otherPort?.served === false);
} finally {
  process.env.PATH = originalPath;
  delete process.env.STUB_SERVE;
}

check('Tailscale が無い環境では何もしない（起動を妨げない）',
  await (async () => {
    process.env.PATH = '/nonexistent';
    const r = await detectTailnet(PORT);
    process.env.PATH = originalPath;
    return r === null;
  })());

process.exit(finish() ? 1 : 0);
