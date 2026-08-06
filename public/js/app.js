import { api } from './api.js';
import { cache } from './db.js';
import { el, setChildren, toast } from './util.js';
import { renderHome } from './views/home.js';
import { renderProcessing } from './views/processing.js';
import { renderResult } from './views/result.js';
import { openGlossary } from './views/glossary.js';

const root = document.getElementById('app');
let teardown = null;

const ctx = {
  system: null,
  presets: [],
  navigate(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  },
  reload: () => route(),
};

async function boot() {
  try {
    const [system, presets] = await Promise.all([api.system(), api.presets()]);
    ctx.system = system;
    ctx.presets = presets.presets;
  } catch {
    // サーバに繋がらなくても、キャッシュ済みの結果は見られるようにする
    ctx.system = {
      ready: false,
      offline: true,
      ffmpeg: { ok: true },
      engines: [],
      models: [],
      supportedExtensions: [],
      exportFormats: [],
      defaults: {},
      anthropicConfigured: false,
    };
    ctx.presets = [];
    toast('サーバに接続できません。保存済みの結果のみ閲覧できます。', 'error');
  }

  document.getElementById('nav-home').addEventListener('click', () => ctx.navigate('#/'));
  document.getElementById('nav-glossary').addEventListener('click', () => openGlossary({ rc: ctx }));
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  teardown?.();
  teardown = null;

  const hash = location.hash || '#/';
  const jobMatch = /^#\/job\/([\w-]+)/.exec(hash);

  if (!jobMatch) {
    await renderHome(root, ctx);
    return;
  }

  const jobId = jobMatch[1];
  root.className = '';
  setChildren(root, el('div', { class: 'card empty' }, el('span', { class: 'spinner' }), ' 読み込んでいます…'));

  let data;
  try {
    data = await api.getJob(jobId);
  } catch (err) {
    const cached = await cache.get(jobId);
    if (cached) {
      toast('サーバから取得できないため、保存済みの結果を表示しています', 'error');
      data = { job: cached.job, segments: cached.segments, summaries: cached.summaries || [] };
    } else {
      setChildren(root, el('div', { class: 'card empty' },
        el('p', {}, err.message),
        el('button', { class: 'btn', onclick: () => ctx.navigate('#/') }, '一覧へ戻る')));
      return;
    }
  }

  teardown = data.job.status === 'completed'
    ? renderResult(root, ctx, data)
    : renderProcessing(root, ctx, data.job);
}

boot();
