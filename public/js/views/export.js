import { api } from '../api.js';
import { copyToClipboard, el, toast } from '../util.js';

/** FR-09 エクスポート。ダウンロードとクリップボードコピーの両方に対応する。 */
export function openExport(rc) {
  const state = {
    format: 'md',
    include: 'both',
    timestamps: true,
    summaryId: '',
  };

  const summarySelect = el('select', {
    class: 'select',
    onchange: (e) => { state.summaryId = e.target.value; },
  },
    el('option', { value: '' }, 'すべての要約'),
    ...rc.summaries.map((s) => el('option', { value: s.id }, `${s.presetLabel}（${new Date(s.createdAt).toLocaleString('ja-JP')}）`)));

  const params = () => ({
    format: state.format,
    include: state.include,
    timestamps: String(state.timestamps),
    ...(state.summaryId ? { summaryId: state.summaryId } : {}),
  });

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => { if (e.target === backdrop) close(); },
  },
    el('div', { class: 'modal', style: 'max-width:520px' },
      el('header', {}, el('h3', {}, 'エクスポート'), el('button', { class: 'btn btn-ghost btn-sm', onclick: () => close() }, '×')),
      el('div', { class: 'content' },
        el('div', { class: 'field' },
          el('label', {}, '形式'),
          el('select', { class: 'select', onchange: (e) => { state.format = e.target.value; sync(); } },
            ...rc.system.exportFormats.map((f) => el('option', { value: f.id }, `${f.label}（.${f.ext}）`)),
            el('option', { value: 'docx', disabled: true }, 'Word（.docx）— v3以降で対応予定'))),
        el('div', { class: 'field' },
          el('label', {}, '内容'),
          el('select', { class: 'select', onchange: (e) => { state.include = e.target.value; sync(); } },
            el('option', { value: 'both' }, '文字起こし＋要約'),
            el('option', { value: 'transcript' }, '文字起こしのみ'),
            el('option', { value: 'summary' }, '要約のみ'))),
        el('div', { class: 'field', id: 'summary-field' }, el('label', {}, '対象の要約'), summarySelect),
        el('label', { class: 'toggle', id: 'ts-toggle' },
          el('input', {
            type: 'checkbox', checked: state.timestamps,
            onchange: (e) => { state.timestamps = e.target.checked; },
          }), 'タイムスタンプを含める')),
      el('footer', {},
        el('button', {
          class: 'btn grow', style: 'flex:none',
          onclick: async () => {
            try {
              const res = await fetch(api.exportUrl(rc.job.id, params()));
              if (!res.ok) throw new Error('取得に失敗しました');
              await copyToClipboard(await res.text());
            } catch (err) { toast(err.message, 'error'); }
          },
        }, '📋 クリップボードへコピー'),
        el('div', { class: 'grow' }),
        el('button', { class: 'btn', onclick: () => close() }, 'キャンセル'),
        el('button', {
          class: 'btn btn-primary',
          onclick: () => {
            window.location.href = api.exportUrl(rc.job.id, params());
            close();
          },
        }, 'ダウンロード'))));

  function sync() {
    const isSubtitle = state.format === 'srt' || state.format === 'vtt';
    backdrop.querySelector('#summary-field').style.display =
      state.include === 'transcript' || isSubtitle || !rc.summaries.length ? 'none' : '';
    backdrop.querySelector('#ts-toggle').style.display = isSubtitle ? 'none' : '';
  }

  document.body.append(backdrop);
  sync();

  function close() { backdrop.remove(); }
}
