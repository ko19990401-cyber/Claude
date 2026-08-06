import { api, subscribeJob } from '../api.js';
import {
  addChildren, el, formatDuration, formatTime, notify, setChildren, toast,
} from '../util.js';

const PHASES = [
  { id: 'preprocessing', label: '音声の前処理（モノラル16kHz / Opus 24kbps へ変換）' },
  { id: 'uploading', label: 'ASRへの送信' },
  { id: 'transcribing', label: '文字起こし（話者分離つき）' },
];

const ORDER = ['queued', 'preprocessing', 'uploading', 'transcribing', 'completed'];

/**
 * 処理中画面（§10.1）。
 * 単なるスピナーではなく、現在フェーズ・経過秒数・推定残り時間を出す。
 */
export function renderProcessing(root, ctx, job) {
  root.className = '';
  const startedAt = new Date(job.createdAt).getTime();
  const estimatedTotalSec = Math.max(30, (job.source.durationSec || 600) / 10);

  const phaseHost = el('div', { class: 'phase-list' });
  const bar = el('div', { class: 'bar' }, el('i', { style: 'width:0%' }));
  const elapsedEl = el('b', {}, '00:00:00');
  const remainEl = el('b', {}, '—');
  const logHost = el('div', { class: 'log' });
  const actions = el('div', { style: 'display:flex;gap:8px;justify-content:flex-end' });

  let status = job.status;
  let ratio = 0;

  const card = el('div', { class: 'card progress-card' },
    el('div', {},
      el('h2', { style: 'margin:0 0 4px;font-size:18px' }, job.title),
      el('p', { class: 'hint', style: 'margin:0' },
        `${job.source.fileName}　${job.source.durationSec ? formatDuration(job.source.durationSec) : '長さ不明'}`)),
    phaseHost,
    bar,
    el('div', { class: 'timers' },
      el('div', {}, elapsedEl, '経過'),
      el('div', {}, remainEl, '推定残り')),
    el('p', { class: 'hint' }, 'この画面を閉じても処理は継続します。完了したらブラウザ通知でお知らせします。'),
    logHost,
    actions);

  setChildren(root, card);
  renderPhases();
  renderActions();

  function renderPhases() {
    const currentIndex = ORDER.indexOf(status);
    setChildren(phaseHost, ...PHASES.map((phase) => {
      const index = ORDER.indexOf(phase.id);
      const state = currentIndex > index ? 'done' : currentIndex === index ? 'active' : '';
      return el('div', { class: `phase ${state}` },
        el('span', { class: 'mark' }, state === 'done' ? '✓' : state === 'active' ? el('span', { class: 'spinner' }) : '○'),
        el('span', { class: 'label' }, phase.label),
        el('span', { class: 'detail', dataset: { phase: phase.id } }, ''));
    }));
  }

  function renderActions() {
    setChildren(actions,
      el('button', { class: 'btn', onclick: () => ctx.navigate('#/') }, '一覧へ戻る'),
      status === 'failed'
        ? el('button', {
            class: 'btn btn-primary',
            onclick: async () => {
              try {
                await api.retryJob(job.id);
                toast('再試行を開始しました', 'ok');
                ctx.reload();
              } catch (err) { toast(err.message, 'error'); }
            },
          }, '再試行')
        : null);
  }

  function addLog(text, kind = '') {
    const line = el('div', { class: kind },
      el('span', { class: 't' }, `${new Date().toLocaleTimeString('ja-JP')} `), text);
    addChildren(logHost, line);
    logHost.scrollTop = logHost.scrollHeight;
  }

  const timer = setInterval(() => {
    const elapsed = (Date.now() - startedAt) / 1000;
    elapsedEl.textContent = formatTime(elapsed);
    if (status === 'completed' || status === 'failed') return;
    const progress = Math.max(ratio, Math.min(0.95, elapsed / estimatedTotalSec));
    const remain = Math.max(0, (elapsed / Math.max(progress, 0.02)) - elapsed);
    remainEl.textContent = ratio > 0 || elapsed > 10 ? `約${formatDuration(remain)}` : '算出中';
  }, 1000);

  const unsubscribe = subscribeJob(job.id, {
    snapshot: (data) => {
      if (data.job) {
        status = data.job.status;
        renderPhases();
        renderActions();
        if (status === 'completed') finish();
      }
    },
    status: (event) => {
      status = event.status;
      renderPhases();
      renderActions();
    },
    phase: (event) => {
      addLog(event.label);
      bar.classList.add('indeterminate');
    },
    progress: (event) => {
      if (typeof event.ratio === 'number') {
        ratio = event.ratio;
        bar.classList.remove('indeterminate');
        bar.firstChild.style.width = `${Math.round(ratio * 100)}%`;
      }
      const detail = phaseHost.querySelector(`[data-phase="${event.phase}"]`);
      if (detail) {
        detail.textContent = event.detail
          || (event.processedSec ? `${formatTime(event.processedSec)} 処理済み`
            : event.waitedSec ? `${event.waitedSec}秒 待機中` : '');
      }
    },
    chunks: (event) => addLog(`音声を${event.count}分割して処理します`),
    warning: (event) => { addLog(`⚠ ${event.message}`); toast(event.message, 'error'); },
    retry: (event) => addLog(`⟳ 再試行 ${event.attempt}/${event.retries}（${Math.round(event.waitMs / 1000)}秒後）: ${event.message}`),
    completed: (event) => {
      addLog(`✓ 完了：${event.segmentCount}セグメント${event.replaced ? `／辞書で${event.replaced}箇所を補正` : ''}`);
      finish(event);
    },
    failed: (event) => {
      status = 'failed';
      bar.classList.remove('indeterminate');
      addLog(`✘ 失敗：${event.message}`);
      renderPhases();
      renderActions();
      toast(event.message, 'error');
    },
  });

  function finish(event) {
    status = 'completed';
    bar.classList.remove('indeterminate');
    bar.firstChild.style.width = '100%';
    remainEl.textContent = '完了';
    renderPhases();
    notify('文字起こしが完了しました', `${job.title}${event ? `：${event.segmentCount}セグメント` : ''}`);
    setTimeout(() => ctx.reload(), 600);
  }

  return () => {
    clearInterval(timer);
    unsubscribe();
  };
}
