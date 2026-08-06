import { api } from '../api.js';
import { VirtualList } from '../virtualList.js';
import {
  debounce, el, escapeHtml, formatDuration, formatTime, setChildren, toast,
} from '../util.js';

/** FR-06 文字起こしビュー。 */
export function renderTranscript(root, rc) {
  const options = {
    timestamps: true,
    colors: true,
    follow: true,
  };
  let query = '';
  let hits = [];
  let hitIndex = 0;
  let playingIndex = -1;

  // --- 検索・表示切替のツールバー ---------------------------------------
  const searchInput = el('input', { class: 'input', type: 'search', placeholder: '全文検索' });
  const hitLabel = el('span', {}, '');
  const prevButton = el('button', { class: 'btn btn-sm', disabled: true, onclick: () => jumpHit(-1) }, '↑');
  const nextButton = el('button', { class: 'btn btn-sm', disabled: true, onclick: () => jumpHit(1) }, '↓');

  const searchNav = el('div', { class: 'search-nav', style: 'display:none' }, hitLabel, prevButton, nextButton);

  const toolbar = el('div', { class: 'toolbar' },
    el('div', { class: 'search' }, el('span', { class: 'glass' }, '🔍'), searchInput),
    searchNav,
    toggle('タイムスタンプ', options.timestamps, (v) => { options.timestamps = v; list.setItems(rc.segments); }),
    toggle('話者色分け', options.colors, (v) => {
      options.colors = v;
      scroller.classList.toggle('no-color', !v);
    }),
    toggle('再生に追従', options.follow, (v) => { options.follow = v; }));

  const speakerBar = el('div', { class: 'speaker-bar' });
  const scroller = el('div', { class: 'transcript-scroll' });
  setChildren(root, toolbar, speakerBar, scroller);

  renderSpeakers();

  const list = new VirtualList(scroller, {
    items: rc.segments,
    estimateHeight: 78,
    renderItem,
    key: (segment) => segment.id,
  });

  // --- 話者チップ（インライン編集で全セグメントへ即時反映）---------------
  function renderSpeakers() {
    const total = rc.job.speakers.reduce((n, s) => n + s.totalSec, 0) || 1;
    setChildren(speakerBar, ...rc.job.speakers.map((speaker) => {
      const name = el('span', {
        class: 'name',
        contentEditable: 'true',
        spellcheck: false,
        onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
        onblur: async (e) => {
          const label = e.target.textContent.trim();
          if (!label || label === speaker.label) { e.target.textContent = speaker.label; return; }
          try {
            const result = await api.updateSpeakers(rc.job.id, [{ id: speaker.id, label }]);
            rc.job.speakers = result.speakers;
            speaker.label = label;
            // セグメントは speakerId しか持たないので、表示だけ差し替えれば足りる
            list.updateVisible((node, segment) => {
              if (segment.speakerId === speaker.id) node.querySelector('.who').textContent = label;
            });
            renderSpeakers();
          } catch (err) {
            toast(err.message, 'error');
            e.target.textContent = speaker.label;
          }
        },
      }, speaker.label);

      return el('div', { class: 'speaker-chip', style: `--sp:${rc.color(speaker.id)}` },
        el('span', { class: 'swatch' }),
        name,
        el('span', { class: 'stat' },
          `${speaker.utteranceCount}回 / ${formatDuration(speaker.totalSec)}（${Math.round((speaker.totalSec / total) * 100)}%）`));
    }));
  }

  // --- セグメント描画 -----------------------------------------------------
  function renderItem(segment, index) {
    const label = rc.job.speakers.find((s) => s.id === segment.speakerId)?.label || `話者${segment.speakerId}`;
    const lowConfidence = typeof segment.confidence === 'number' && segment.confidence < 0.6;

    const body = el('div', {
      class: 'body',
      contentEditable: 'true',
      spellcheck: false,
      onfocus: (e) => { e.target.dataset.before = e.target.textContent; },
      onblur: async (e) => {
        const text = e.target.textContent.replace(/\s+$/, '');
        if (text === e.target.dataset.before) { paintBody(e.target, text); return; }
        try {
          await api.updateSegment(rc.job.id, segment.id, { text });
          segment.text = text;
          segment.edited = true;
          rc.setSegments(rc.segments);
          e.target.parentElement.querySelector('.flags').replaceChildren(el('span', { class: 'flag', title: '編集済み' }, '✎'));
          if (query) runSearch(query, { keepIndex: true });
        } catch (err) {
          toast(err.message, 'error');
          e.target.textContent = segment.text;
        }
        paintBody(e.target, segment.text);
      },
    });
    paintBody(body, segment.text);

    const node = el('div', {
      class: `segment${lowConfidence ? ' low-conf' : ''}${index === playingIndex ? ' playing' : ''}`,
      style: `--sp:${rc.color(segment.speakerId)}`,
      dataset: { id: segment.id },
    },
      el('div', { class: 'gutter' },
        options.timestamps
          ? el('button', {
              class: 'time',
              title: 'この位置から再生',
              onclick: () => rc.seek(segment.start),
            }, formatTime(segment.start))
          : null,
        el('div', { class: 'who', title: label }, label),
        el('div', { class: 'flags' }, segment.edited ? el('span', { class: 'flag', title: '編集済み' }, '✎') : null)),
      body);

    // タイムスタンプ非表示でもクリックで再生できるようにしておく
    node.addEventListener('dblclick', (e) => {
      if (!e.target.closest('.body')) rc.seek(segment.start);
    });
    return node;
  }

  function paintBody(node, text) {
    if (!query) { node.textContent = text; return; }
    const pattern = new RegExp(escapeRegExp(query), 'gi');
    node.innerHTML = escapeHtml(text).replace(pattern, (m) => `<mark>${escapeHtml(m)}</mark>`);
  }

  // --- 検索（インクリメンタル）-------------------------------------------
  searchInput.addEventListener('input', debounce((e) => runSearch(e.target.value.trim()), 180));
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jumpHit(e.shiftKey ? -1 : 1); }
  });

  function runSearch(value, { keepIndex = false } = {}) {
    query = value;
    hits = [];
    if (query) {
      const needle = query.toLowerCase();
      rc.segments.forEach((segment, index) => {
        if (segment.text.toLowerCase().includes(needle)) hits.push(index);
      });
    }
    if (!keepIndex) hitIndex = 0;
    hitLabel.textContent = query ? (hits.length ? `${Math.min(hitIndex + 1, hits.length)} / ${hits.length}件` : '0件') : '';
    prevButton.disabled = nextButton.disabled = hits.length === 0;
    searchNav.style.display = query ? '' : 'none';
    list.updateVisible((node, segment) => paintBody(node.querySelector('.body'), segment.text));
    if (query && hits.length && !keepIndex) list.scrollToIndex(hits[0]);
  }

  function jumpHit(direction) {
    if (!hits.length) return;
    hitIndex = (hitIndex + direction + hits.length) % hits.length;
    hitLabel.textContent = `${hitIndex + 1} / ${hits.length}件`;
    list.scrollToIndex(hits[hitIndex]);
  }

  // --- 再生位置の追従（timeupdate でハイライト）---------------------------
  const onTimeUpdate = () => {
    const time = rc.audio.currentTime;
    const index = findSegmentIndex(rc.segments, time);
    if (index === playingIndex) return;
    playingIndex = index;
    list.updateVisible((node, _segment, i) => node.classList.toggle('playing', i === index));
    if (options.follow && index >= 0 && !list.isVisible(index)) list.scrollToIndex(index);
  };
  rc.audio.addEventListener('timeupdate', onTimeUpdate);

  const onSeek = () => setTimeout(onTimeUpdate, 30);
  window.addEventListener('seek', onSeek);

  // 辞書適用などでセグメントが差し替わったときの再描画
  const onSegments = () => {
    list.setItems(rc.segments);
    renderSpeakers();
    if (query) runSearch(query, { keepIndex: true });
  };
  window.addEventListener('segments-changed', onSegments);

  return {
    destroy() {
      rc.audio.removeEventListener('timeupdate', onTimeUpdate);
      window.removeEventListener('seek', onSeek);
      window.removeEventListener('segments-changed', onSegments);
      list.destroy();
    },
  };
}

function toggle(label, initial, onChange) {
  const input = el('input', { type: 'checkbox', checked: initial, onchange: (e) => onChange(e.target.checked) });
  return el('label', { class: 'toggle' }, input, label);
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 再生位置に対応するセグメントを二分探索で求める。 */
function findSegmentIndex(segments, time) {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const segment = segments[mid];
    if (time < segment.start) hi = mid - 1;
    else if (time > segment.end) { found = mid; lo = mid + 1; }
    else return mid;
  }
  return found;
}
