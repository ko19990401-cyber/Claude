import { Hono } from 'hono';
import { MODEL_PRICES, SUPPORTED_EXTENSIONS, config } from '../config.js';
import { listEngines } from '../asr/index.js';
import { checkFfmpeg } from '../lib/ffmpeg.js';
import { estimate } from '../lib/estimate.js';
import { EXPORT_FORMATS } from '../lib/exporters.js';
import { getGlossary, listGlossaries, saveGlossary } from '../lib/store.js';
import { PRESETS } from '../llm/presets.js';

export const miscRoute = new Hono();

/** 起動時チェックの結果をフロントに返す（§11：ffmpeg未インストール／APIキー未設定）。 */
miscRoute.get('/system', async (c) => {
  const ffmpeg = await checkFfmpeg();
  const engines = listEngines();
  const active = engines.find((e) => e.isDefault);
  return c.json({
    ffmpeg,
    engines,
    activeEngine: active,
    anthropicConfigured: Boolean(config.keys.anthropic),
    models: Object.entries(MODEL_PRICES).map(([id, v]) => ({ id, ...v })),
    defaults: {
      model: config.summaryModel,
      effort: config.summaryEffort,
      language: config.asrLanguage,
      provider: config.asrProvider,
    },
    supportedExtensions: SUPPORTED_EXTENSIONS,
    exportFormats: Object.entries(EXPORT_FORMATS).map(([id, v]) => ({ id, ...v })),
    hierarchicalThreshold: config.hierarchicalThreshold,
    usdJpy: config.usdJpy,
    ready: ffmpeg.ok && Boolean(active?.configured),
  });
});

miscRoute.get('/presets', (c) =>
  c.json({
    presets: PRESETS.map(({ id, label, description, custom }) => ({ id, label, description, custom: Boolean(custom) })),
  }));

miscRoute.post('/estimate', async (c) => {
  const body = await c.req.json();
  const durationSec = Number(body.durationSec);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw Object.assign(new Error('durationSec が不正です'), { status: 400 });
  }
  return c.json(estimate({
    durationSec,
    fileBytes: Number(body.fileBytes) || 0,
    provider: body.provider || config.asrProvider,
    model: body.model || config.summaryModel,
  }));
});

// --- 用語辞書 -------------------------------------------------------------
miscRoute.get('/glossaries', async (c) => c.json({ glossaries: await listGlossaries() }));

miscRoute.get('/glossaries/:id', async (c) => {
  const glossary = await getGlossary(c.req.param('id'));
  if (!glossary) throw Object.assign(new Error('辞書が見つかりません'), { status: 404 });
  return c.json({ glossary });
});

miscRoute.put('/glossaries/:id', async (c) => {
  const id = c.req.param('id');
  if (!/^glo_[\w-]+$/.test(id)) throw Object.assign(new Error('辞書IDが不正です'), { status: 400 });
  const body = await c.req.json();

  const replace = (Array.isArray(body.replace) ? body.replace : [])
    .filter((r) => r && typeof r.from === 'string' && r.from.length)
    .map((r) => ({ from: r.from, to: String(r.to ?? ''), regex: Boolean(r.regex), flags: r.flags || 'g' }));

  // 不正な正規表現は保存前に弾く（適用時に黙って無視されると原因が分からなくなる）
  for (const rule of replace.filter((r) => r.regex)) {
    try {
      new RegExp(rule.from, rule.flags);
    } catch (err) {
      throw Object.assign(new Error(`正規表現が不正です: ${rule.from} (${err.message})`), { status: 400 });
    }
  }

  const glossary = await saveGlossary({
    id,
    name: String(body.name || '辞書').slice(0, 60),
    boost: (Array.isArray(body.boost) ? body.boost : [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .slice(0, 1000),
    replace,
  });
  return c.json({ glossary });
});
