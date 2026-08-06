import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { config } from './config.js';
import { listEngines } from './asr/index.js';
import { checkFfmpeg } from './lib/ffmpeg.js';
import { log } from './lib/logger.js';
import { resumeJobs } from './lib/pipeline.js';
import { detectTailnet } from './lib/tailscale.js';
import { ensureDirs } from './lib/store.js';
import { jobsRoute } from './routes/jobs.js';
import { miscRoute } from './routes/misc.js';

const app = new Hono();

// 死活監視用。認証より前に置き、ホスティング側のヘルスチェックが通るようにする。
app.get('/api/health', (c) => c.json({ ok: true, uptimeSec: Math.round(process.uptime()) }));

// --- 簡易認証（§15-4）------------------------------------------------------
// AUTH_USER / AUTH_PASSWORD を設定すると全体に Basic 認証がかかる。
// EventSource や <audio> はヘッダを自前で付けられないが、Basic 認証なら
// ブラウザが自動で付与するため、SSEも音声配信もそのまま動く。
if (config.auth.user && config.auth.password) {
  app.use('*', basicAuth({ username: config.auth.user, password: config.auth.password }));
}

app.use('*', async (c, next) => {
  const started = Date.now();
  await next();
  if (c.req.path.startsWith('/api') && !c.req.path.endsWith('/events')) {
    log.info(`${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - started}ms`);
  }
});

app.route('/api/jobs', jobsRoute);
app.route('/api', miscRoute);

app.onError((err, c) => {
  // Basic認証の401は WWW-Authenticate ヘッダを含む応答をそのまま返す。
  // ここでJSONに作り替えるとヘッダが落ち、ブラウザが認証ダイアログを出せなくなる。
  if (typeof err.getResponse === 'function') return err.getResponse();

  const status = err.status || 500;
  if (status >= 500) log.error(`${c.req.method} ${c.req.path}:`, err.stack || err.message);
  else log.warn(`${c.req.method} ${c.req.path}: ${err.message}`);
  return c.json({ error: { message: err.message, code: err.code } }, status);
});

// サーバが静的ファイルも配信する（二重起動を避けるため。§4.2）
const staticRoot = `./${path.relative(process.cwd(), config.publicDir).split(path.sep).join('/') || '.'}`;
app.use('/*', serveStatic({ root: staticRoot }));
app.notFound((c) =>
  c.req.path.startsWith('/api')
    ? c.json({ error: { message: 'not found' } }, 404)
    : c.redirect('/'));

async function main() {
  await ensureDirs();

  const authEnabled = Boolean(config.auth.user && config.auth.password);
  if (config.auth.required && !authEnabled) {
    log.error('REQUIRE_AUTH が有効ですが AUTH_USER / AUTH_PASSWORD が未設定です。');
    log.error('公開環境では認証なしで起動しません。両方を設定してください。');
    process.exit(1);
  }

  const ffmpeg = await checkFfmpeg();
  const engines = listEngines();
  const active = engines.find((e) => e.isDefault);

  log.info('─'.repeat(64));
  if (ffmpeg.ok) log.ok(`ffmpeg: ${ffmpeg.version}`);
  else {
    log.warn('ffmpeg が見つかりません。音声の前処理ができません。');
    log.warn('  macOS: brew install ffmpeg / Ubuntu: sudo apt install ffmpeg');
    log.warn('  Windows: winget install Gyan.FFmpeg');
  }

  if (active?.configured) log.ok(`ASR: ${active.label}（${active.mode === 'async' ? '非同期' : '同期'}API）`);
  else log.warn(`ASR: ${active?.label || config.asrProvider} のAPIキーが未設定です（.env の設定を確認してください）`);

  if (config.keys.anthropic) log.ok(`要約モデル: ${config.summaryModel}（effort: ${config.summaryEffort}）`);
  else log.warn('ANTHROPIC_API_KEY が未設定です。要約機能は利用できません。');

  if (authEnabled) log.ok(`Basic認証: 有効（ユーザー ${config.auth.user}）`);
  else if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    log.warn('認証なしで外部からの接続を受け付けています。');
    log.warn('  公開する場合は AUTH_USER / AUTH_PASSWORD を設定してください。');
  }

  const resumed = await resumeJobs();
  if (resumed) log.info(`未完了ジョブ ${resumed} 件を確認しました`);

  serve({ fetch: app.fetch, port: config.port, hostname: config.host }, async ({ port }) => {
    log.ok(`http://localhost:${port} を開いてください`);

    // Tailscale 経由でスマホから使えるなら、そのURLも案内する。
    // npm run share から起動された場合は、そちらが案内するので黙る。
    if (!process.env.SHARE_MANAGED) {
      const tailnet = await detectTailnet(port);
      if (tailnet?.served) {
        log.ok(`スマホからは ${tailnet.url} （Tailscale・HTTPS）`);
      } else if (tailnet) {
        log.info(`Tailscale を検出しました（${tailnet.dns}）`);
        log.info('  npm run share を使うと、スマホから使える状態まで自動で用意します');
      }
    }
    log.info('─'.repeat(64));
  });
}

main().catch((err) => {
  log.error('起動に失敗しました:', err.stack || err.message);
  process.exit(1);
});
