import { api } from '../api.js';
import { cache } from '../db.js';
import {
  addChildren, confirmDialog, el, formatBytes, formatDateTime, formatDuration, setChildren, toast,
} from '../util.js';

const STATUS_LABELS = {
  queued: { text: '待機中', cls: 'badge-run' },
  preprocessing: { text: '変換中', cls: 'badge-run' },
  uploading: { text: '送信中', cls: 'badge-run' },
  transcribing: { text: '文字起こし中', cls: 'badge-run' },
  completed: { text: '完了', cls: 'badge-ok' },
  failed: { text: '失敗', cls: 'badge-fail' },
};

export async function renderHome(root, ctx) {
  root.className = '';
  setChildren(root);

  if (!ctx.system.ready) root.append(setupBanner(ctx.system));

  // スマホにはドラッグ＆ドロップが無いので、タップ操作の案内に切り替える
  const touch = window.matchMedia('(pointer: coarse)').matches;
  const dropzone = el('div', { class: 'dropzone', id: 'dropzone' },
    el('div', { class: 'icon' }, '🎙️'),
    el('h2', {}, touch ? 'タップしてファイルを選択' : '音声・動画ファイルをドロップ'),
    el('p', {}, `${touch ? '' : 'クリックして選択もできます　'}対応形式: ${ctx.system.supportedExtensions.join(' / ')}`),
    el('p', { class: 'hint', style: 'margin-top:8px' }, 'ファイルサイズ・再生時間の上限はありません'));

  const fileInput = el('input', {
    type: 'file',
    // iOS では拡張子だけの accept で選択できないファイルがあるため MIME も併記する
    accept: [...ctx.system.supportedExtensions, 'audio/*', 'video/*'].join(','),
    style: 'display:none',
  });

  const confirmHost = el('div');
  const listHost = el('div');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) pick(fileInput.files[0]);
    fileInput.value = '';
  });

  async function pick(file) {
    const ext = `.${file.name.split('.').pop().toLowerCase()}`;
    if (!ctx.system.supportedExtensions.includes(ext)) {
      toast(`非対応の形式です（${ext}）。対応形式: ${ctx.system.supportedExtensions.join(' / ')}`, 'error');
      return;
    }
    setChildren(confirmHost, el('div', { class: 'card confirm' },
      el('div', { style: 'display:flex;align-items:center;gap:12px' }, el('span', { class: 'spinner' }), '再生時間を読み取っています…')));
    const durationSec = await readDuration(file);
    await showConfirm(file, durationSec);
  }

  async function showConfirm(file, durationSec) {
    const state = {
      provider: ctx.system.defaults.provider,
      model: ctx.system.defaults.model,
      language: ctx.system.defaults.language,
      speakerCount: '',
      glossaryId: 'glo_default',
      title: file.name.replace(/\.[^.]+$/, ''),
    };

    const estimateHost = el('div', { class: 'estimate-grid' });
    const noteHost = el('div');

    const refresh = async () => {
      try {
        const result = await api.estimate({
          durationSec,
          fileBytes: file.size,
          provider: state.provider,
          model: state.model,
        });
        setChildren(estimateHost,
          cell('ファイル', formatBytes(file.size), file.name),
          cell('再生時間', durationSec ? formatDuration(durationSec) : '不明', durationSec ? '' : '推定できませんでした'),
          cell('推定処理時間', durationSec ? `約${formatDuration(result.time.totalSec)}` : '—', '前処理＋文字起こし'),
          cell('推定コスト', durationSec ? `約${Math.round(result.cost.totalJpy)}円` : '—',
            `文字起こし ${Math.round(result.cost.asrJpy)}円 ＋ 要約 ${Math.round(result.cost.summaryJpy)}円`),
        );
        const notes = [];
        if (result.willChunk) notes.push('⚠ API上限を超えるため、無音区間で分割して処理します（話者ラベルの精度が落ちる可能性があります）。');
        if (result.hierarchical) notes.push('ℹ 文字数が多いため、要約は階層要約（分割→統合）で行われます。');
        setChildren(noteHost, ...notes.map((n) => el('p', { class: 'hint' }, n)));
      } catch (err) {
        setChildren(estimateHost, el('p', { class: 'hint' }, `試算に失敗しました: ${err.message}`));
      }
    };

    const engineOptions = ctx.system.engines.map((e) =>
      el('option', { value: e.id, selected: e.id === state.provider, disabled: !e.configured },
        `${e.label}${e.configured ? '' : '（APIキー未設定）'}`));

    const glossaries = await api.listGlossaries().catch(() => ({ glossaries: [] }));

    const card = el('div', { class: 'card confirm' },
      el('h3', {}, 'この内容で処理しますか？'),
      estimateHost,
      noteHost,
      el('div', { class: 'options-row' },
        field('タイトル', el('input', {
          class: 'input', value: state.title, oninput: (e) => { state.title = e.target.value; },
        })),
        field('文字起こしエンジン', el('select', {
          class: 'select', onchange: (e) => { state.provider = e.target.value; refresh(); },
        }, ...engineOptions)),
        field('言語', el('select', { class: 'select', onchange: (e) => { state.language = e.target.value; } },
          el('option', { value: 'ja', selected: state.language === 'ja' }, '日本語'),
          el('option', { value: 'en', selected: state.language === 'en' }, '英語'),
          el('option', { value: 'auto', selected: state.language === 'auto' }, '自動判定'))),
        field('話者数（任意）', el('input', {
          class: 'input', type: 'number', min: '1', max: '20', placeholder: '不明なら空欄',
          oninput: (e) => { state.speakerCount = e.target.value; },
        }), '分かっている場合だけ指定すると精度が上がります'),
        field('用語辞書', el('select', { class: 'select', onchange: (e) => { state.glossaryId = e.target.value; } },
          el('option', { value: '' }, '使用しない'),
          ...(glossaries.glossaries || []).map((g) =>
            el('option', { value: g.id, selected: g.id === state.glossaryId }, `${g.name}（${g.boost.length}語 / ${g.replace.length}置換）`)))),
      ),
      el('div', { class: 'confirm-actions' },
        el('button', { class: 'btn', onclick: () => setChildren(confirmHost) }, 'キャンセル'),
        el('button', { class: 'btn btn-primary', id: 'start-btn', onclick: () => start() }, '実行する')));

    setChildren(confirmHost, card);
    refresh();

    async function start() {
      const button = card.querySelector('#start-btn');
      button.disabled = true;
      const bar = el('div', { class: 'bar' }, el('i', { style: 'width:0%' }));
      button.after(bar);
      try {
        const job = await api.upload(file, {
          title: state.title,
          durationSec: Math.round(durationSec),
          provider: state.provider,
          language: state.language,
          speakerCount: state.speakerCount,
          glossaryId: state.glossaryId,
        }, {
          onProgress: (ratio) => { bar.firstChild.style.width = `${Math.round(ratio * 100)}%`; },
        });
        ctx.navigate(`#/job/${job.id}`);
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        bar.remove();
      }
    }
  }

  root.append(dropzone, fileInput, confirmHost, listHost);
  await renderJobList(listHost, ctx);
}

function setupBanner(system) {
  const items = [];
  if (!system.ffmpeg.ok) {
    items.push(el('div', {},
      el('b', {}, 'ffmpeg が見つかりません'),
      '音声の前処理に必要です。インストール後、サーバを再起動してください。',
      el('div', {}, 'macOS: ', el('code', {}, 'brew install ffmpeg'), '　Ubuntu: ', el('code', {}, 'sudo apt install ffmpeg'),
        '　Windows: ', el('code', {}, 'winget install Gyan.FFmpeg'))));
  }
  if (!system.activeEngine?.configured) {
    items.push(el('div', {},
      el('b', {}, `${system.activeEngine?.label || 'ASR'} のAPIキーが未設定です`),
      '.env に ', el('code', {}, `${system.activeEngine?.id === 'assemblyai' ? 'ASSEMBLYAI_API_KEY' : system.activeEngine?.id === 'deepgram' ? 'DEEPGRAM_API_KEY' : 'ELEVENLABS_API_KEY'}=...`),
      ' を追記してサーバを再起動してください。'));
  }
  if (!system.anthropicConfigured) {
    items.push(el('div', {},
      el('b', {}, 'ANTHROPIC_API_KEY が未設定です'),
      '文字起こしは利用できますが、要約は生成できません。'));
  }
  return el('div', { class: 'banner' }, el('div', {}, '⚠'), el('div', {}, ...items));
}

const cell = (k, v, u) => el('div', { class: 'estimate-cell' },
  el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), u ? el('div', { class: 'u' }, u) : null);

const field = (label, control, hint) => el('div', { class: 'field' },
  el('label', {}, label), control, hint ? el('div', { class: 'hint' }, hint) : null);

/** ブラウザ側で再生時間を読む（アップロード前に試算するため）。 */
function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const media = document.createElement('video');
    const done = (value) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(value) && value > 0 ? value : 0);
    };
    media.preload = 'metadata';
    media.onloadedmetadata = () => done(media.duration);
    media.onerror = () => done(0);
    setTimeout(() => done(media.duration), 8000);
    media.src = url;
  });
}

async function renderJobList(host, ctx) {
  setChildren(host, el('div', { class: 'section-head' }, el('h2', {}, '履歴'), el('span', { class: 'spinner' })));
  let jobs = [];
  let offline = false;
  try {
    jobs = (await api.listJobs()).jobs;
  } catch {
    offline = true;
    const cached = (await cache.all()) || [];
    jobs = cached.map((c) => c.job).filter(Boolean);
  }

  const head = el('div', { class: 'section-head' },
    el('h2', {}, '履歴'),
    el('span', { class: 'hint' }, `${jobs.length}件`),
    offline ? el('span', { class: 'badge badge-warn' }, 'オフライン：保存済みの結果のみ表示') : null);

  if (!jobs.length) {
    setChildren(host, head, el('div', { class: 'card empty' }, 'まだ処理したファイルはありません'));
    return;
  }

  const grid = el('div', { class: 'job-grid' });
  for (const job of jobs) {
    const status = STATUS_LABELS[job.status] || { text: job.status, cls: '' };
    addChildren(grid, el('div', {
      class: 'card job-card',
      onclick: (e) => {
        if (e.target.closest('button')) return;
        ctx.navigate(`#/job/${job.id}`);
      },
    },
      el('h3', {}, job.title),
      el('div', { class: 'job-meta' },
        el('span', {}, '🗓', formatDateTime(job.createdAt)),
        el('span', {}, '⏱', job.source.durationSec ? formatDuration(job.source.durationSec) : '—'),
        job.speakers?.length ? el('span', {}, '👥', `${job.speakers.length}人`) : null,
        job.summaryCount ? el('span', {}, '📝', `要約${job.summaryCount}件`) : null),
      el('div', { class: 'job-card-foot' },
        el('span', { class: `badge ${status.cls}` },
          ['queued', 'preprocessing', 'uploading', 'transcribing'].includes(job.status) ? el('span', { class: 'spinner' }) : null,
          status.text),
        job.engine.wasChunked ? el('span', { class: 'badge badge-warn' }, '分割処理') : el('span'),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          title: '削除',
          onclick: async () => {
            const ok = await confirmDialog(
              `「${job.title}」を削除します。\n文字起こし・要約・音声ファイルはすべて物理削除され、元に戻せません。`,
              { danger: true, confirmLabel: '削除する' },
            );
            if (!ok) return;
            try {
              await api.deleteJob(job.id);
              await cache.remove(job.id);
              toast('削除しました', 'ok');
              renderJobList(host, ctx);
            } catch (err) {
              toast(err.message, 'error');
            }
          },
        }, '🗑'))));
  }
  setChildren(host, head, grid);
}
