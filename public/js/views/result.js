import { api } from '../api.js';
import { cache } from '../db.js';
import {
  el, formatDuration, formatTime, setChildren, speakerColor, toast,
} from '../util.js';
import { openGlossary } from './glossary.js';
import { openExport } from './export.js';
import { renderTranscript } from './transcript.js';
import { renderSummary } from './summary.js';

export function renderResult(root, ctx, data) {
  root.className = 'wide';

  const state = {
    job: data.job,
    segments: data.segments,
    summaries: data.summaries,
    tab: location.hash.endsWith('/summary') ? 'summary' : 'transcript',
  };

  // 保存済み結果はIndexedDBにも置く（FR-10：オフラインでも閲覧できる）
  cache.put({ id: state.job.id, job: state.job, segments: state.segments, summaries: state.summaries });

  const audio = new Audio(api.audioUrl(state.job.id));
  audio.preload = 'metadata';
  audio.style.display = 'none';

  const rc = {
    ...ctx,
    get job() { return state.job; },
    get segments() { return state.segments; },
    get summaries() { return state.summaries; },
    audio,
    seek(sec, { play = true } = {}) {
      audio.currentTime = Math.max(0, sec);
      if (play) audio.play().catch(() => { /* 自動再生が拒否されても無視 */ });
      window.dispatchEvent(new CustomEvent('seek', { detail: { sec } }));
    },
    color: (speakerId) => speakerColor(speakerId, state.job.speakers),
    setSegments(segments) {
      state.segments = segments;
      cache.put({ id: state.job.id, job: state.job, segments, summaries: state.summaries });
    },
    setSummaries(summaries) {
      state.summaries = summaries;
      cache.put({ id: state.job.id, job: state.job, segments: state.segments, summaries });
    },
    async refreshJob() {
      const fresh = await api.getJob(state.job.id);
      state.job = fresh.job;
      state.segments = fresh.segments;
      state.summaries = fresh.summaries;
      renderMeta();
      return fresh;
    },
  };

  // --- ヘッダ ------------------------------------------------------------
  const title = el('h1', {
    class: 'result-title',
    contentEditable: 'true',
    spellcheck: false,
    onblur: async (e) => {
      const value = e.target.textContent.trim();
      if (!value || value === state.job.title) { e.target.textContent = state.job.title; return; }
      try {
        await api.renameJob(state.job.id, value);
        state.job.title = value;
        toast('タイトルを変更しました', 'ok');
      } catch (err) {
        toast(err.message, 'error');
        e.target.textContent = state.job.title;
      }
    },
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
  }, state.job.title);

  const metaHost = el('div', { class: 'result-sub' });

  function renderMeta() {
    const { job } = state;
    setChildren(metaHost,
      el('span', {}, `📄 ${job.source.fileName}`),
      el('span', {}, `⏱ ${formatDuration(job.source.durationSec)}`),
      el('span', {}, `👥 ${job.speakers.length}人`),
      el('span', {}, `✍ ${job.stats?.segmentCount ?? state.segments.length}セグメント / ${(job.stats?.charCount ?? 0).toLocaleString()}字`),
      el('span', {}, `⚙ ${job.engine.provider}（${job.engine.language}）`),
      job.engine.wasChunked
        ? el('span', { class: 'badge badge-warn', title: '音声を分割して処理したため、話者ラベルの対応付けに誤りが含まれる可能性があります' }, '分割処理あり')
        : null,
      job.glossaryApplication?.count
        ? el('span', { class: 'badge' }, `辞書で${job.glossaryApplication.count}箇所を補正`)
        : null);
  }
  renderMeta();

  const tabTranscript = el('button', { class: 'tab', onclick: () => switchTab('transcript') }, '文字起こし');
  const tabSummary = el('button', { class: 'tab', onclick: () => switchTab('summary') }, '要約');

  const tabs = el('div', { class: 'tabs' },
    tabTranscript, tabSummary,
    el('div', { class: 'grow' }),
    el('button', {
      class: 'btn btn-sm',
      onclick: () => openGlossary({ jobId: state.job.id, glossaryId: state.job.glossaryId, rc }),
    }, '⚙ 辞書'),
    el('button', {
      class: 'btn btn-sm',
      onclick: () => openExport(rc),
    }, '↓ 出力'));

  const body = el('div');

  // --- プレイヤー（FR-06：セグメントクリックで該当時刻から再生）---------
  const playButton = el('button', { class: 'play', onclick: () => (audio.paused ? audio.play() : audio.pause()) }, '▶');
  const seekBar = el('input', { type: 'range', min: '0', max: '1000', value: '0', step: '1' });
  const timeCurrent = el('span', { class: 'cur' }, '00:00:00');
  const timeTotal = el('span', { class: 'tot' }, ' / 00:00:00');
  const timeLabel = el('span', { class: 't' }, timeCurrent, timeTotal);
  const rateSelect = el('select', {
    class: 'select',
    onchange: (e) => { audio.playbackRate = Number(e.target.value); },
  }, ...[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => el('option', { value: r, selected: r === 1 }, `${r}×`)));

  let seeking = false;
  seekBar.addEventListener('input', () => { seeking = true; });
  seekBar.addEventListener('change', () => {
    seeking = false;
    if (audio.duration) audio.currentTime = (Number(seekBar.value) / 1000) * audio.duration;
  });

  audio.addEventListener('play', () => { playButton.textContent = '❚❚'; });
  audio.addEventListener('pause', () => { playButton.textContent = '▶'; });
  audio.addEventListener('timeupdate', () => {
    const duration = audio.duration || state.job.source.durationSec || 0;
    if (!seeking && duration) seekBar.value = String(Math.round((audio.currentTime / duration) * 1000));
    timeCurrent.textContent = formatTime(audio.currentTime);
    timeTotal.textContent = ` / ${formatTime(duration)}`;
  });
  audio.addEventListener('error', () => {
    playButton.disabled = true;
    timeCurrent.textContent = '音声を読み込めません';
    timeTotal.textContent = '';
  });

  const player = el('div', { class: 'player' },
    audio, // DOMに置くことでブラウザのメディア操作（キーボードの再生キー等）が効く
    playButton,
    seekBar,
    timeLabel,
    el('button', { class: 'btn btn-sm skip', title: '10秒戻る', onclick: () => { audio.currentTime = Math.max(0, audio.currentTime - 10); } }, '⟲10'),
    el('button', { class: 'btn btn-sm skip', title: '10秒進む', onclick: () => { audio.currentTime += 10; } }, '10⟳'),
    rateSelect);

  setChildren(root,
    el('div', { class: 'result-head' }, title),
    metaHost,
    state.job.error ? el('div', { class: 'banner' }, el('div', {}, '⚠'), el('div', {}, state.job.error.message)) : null,
    tabs,
    body,
    player);

  // --- タブ切替 ----------------------------------------------------------
  let active = null;

  function switchTab(tab) {
    if (state.tab === tab && active) return;
    state.tab = tab;
    active?.destroy?.();
    tabTranscript.classList.toggle('active', tab === 'transcript');
    tabSummary.classList.toggle('active', tab === 'summary');
    history.replaceState(null, '', `#/job/${state.job.id}${tab === 'summary' ? '/summary' : ''}`);
    setChildren(body);
    active = tab === 'transcript' ? renderTranscript(body, rc) : renderSummary(body, rc);
  }
  switchTab(state.tab);

  // キーボードショートカット（入力中は無効）
  const onKey = (e) => {
    if (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
    if (e.key === 'ArrowLeft' && e.shiftKey) audio.currentTime = Math.max(0, audio.currentTime - 5);
    if (e.key === 'ArrowRight' && e.shiftKey) audio.currentTime += 5;
  };
  window.addEventListener('keydown', onKey);

  return () => {
    window.removeEventListener('keydown', onKey);
    active?.destroy?.();
    audio.pause();
    audio.src = '';
  };
}
