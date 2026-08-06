import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { config } from './config.js';
import { listEngines } from './asr/index.js';
import { checkFfmpeg } from './lib/ffmpeg.js';
import { log } from './lib/logger.js';
import { resumeJobs } from './lib/pipeline.js';
import { ensureDirs } from './lib/store.js';
import { jobsRoute } from './routes/jobs.js';
import { miscRoute } from './routes/misc.js';

const app = new Hono();

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

  const resumed = await resumeJobs();
  if (resumed) log.info(`未完了ジョブ ${resumed} 件を確認しました`);

  serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
    log.ok(`http://localhost:${port} を開いてください`);
    log.info('─'.repeat(64));
  });
}

main().catch((err) => {
  log.error('起動に失敗しました:', err.stack || err.message);
  process.exit(1);
});
