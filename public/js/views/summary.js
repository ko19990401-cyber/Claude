import { api, streamSummary } from '../api.js';
import { renderMarkdown } from '../markdown.js';
import {
  confirmDialog, copyToClipboard, el, formatDateTime, notify, parseTimestamp, setChildren, toast,
} from '../util.js';

const CUSTOM_PROMPT_KEY = 'koe-note:custom-prompts';

/** FR-07 / FR-08 要約タブ。 */
export function renderSummary(root, rc) {
  const state = {
    presetId: rc.summaries[0]?.presetId || 'minutes',
    model: rc.system.defaults.model,
    effort: rc.system.defaults.effort,
    customPrompt: '',
    selected: rc.summaries[0]?.id || null,
    generating: false,
  };
  let stream = null;

  const presetList = el('div', { class: 'preset-list' });
  const customHost = el('div');
  const generateButton = el('button', { class: 'btn btn-primary', style: 'width:100%', onclick: () => generate() }, '要約を生成');
  const statusHost = el('div', { class: 'gen-status' });
  const pillRow = el('div', { class: 'summary-tab-row' });
  const outputHost = el('div', { class: 'card summary-output' });

  const controls = el('div', { class: 'card summary-controls' },
    el('div', { class: 'field' }, el('label', {}, 'プリセット'), presetList),
    customHost,
    el('div', { class: 'field' },
      el('label', {}, 'モデル'),
      el('select', { class: 'select', onchange: (e) => { state.model = e.target.value; } },
        ...rc.system.models.map((m) => el('option', { value: m.id, selected: m.id === state.model }, m.label))),
      el('div', { class: 'hint' }, '短い要約は安価なモデル、正式な文書は上位モデルへ切り替えられます')),
    el('div', { class: 'field' },
      el('label', {}, '思考の深さ（effort）'),
      el('select', { class: 'select', onchange: (e) => { state.effort = e.target.value; } },
        ...['low', 'medium', 'high', 'xhigh'].map((v) =>
          el('option', { value: v, selected: v === state.effort }, v)))),
    generateButton,
    el('div', { class: 'hint' }, '文字起こしは保持されるので、何度でも作り直せます。'));

  setChildren(root, el('div', { class: 'summary-layout' }, controls,
    el('div', {}, pillRow, statusHost, outputHost)));

  if (!rc.system.anthropicConfigured) {
    generateButton.disabled = true;
    setChildren(statusHost, el('span', { class: 'badge badge-warn' }, 'ANTHROPIC_API_KEY が未設定のため生成できません'));
  }

  renderPresets();
  renderPills();
  renderSelected();

  function renderPresets() {
    setChildren(presetList, ...rc.presets.map((preset) =>
      el('button', {
        class: `preset-item${preset.id === state.presetId ? ' active' : ''}`,
        onclick: () => { state.presetId = preset.id; renderPresets(); renderCustom(); },
      }, el('b', {}, preset.label), el('span', {}, preset.description))));
    renderCustom();
  }

  function renderCustom() {
    const preset = rc.presets.find((p) => p.id === state.presetId);
    if (!preset?.custom) { setChildren(customHost); return; }
    const saved = loadCustomPrompts();
    const area = el('textarea', {
      class: 'textarea',
      placeholder: '例：この会議から、来週の課内会議で共有すべき事項を5点にまとめてください。',
      value: state.customPrompt,
      oninput: (e) => { state.customPrompt = e.target.value; },
    });
    setChildren(customHost, el('div', { class: 'field' },
      el('label', {}, 'プロンプト'),
      area,
      saved.length
        ? el('select', {
            class: 'select',
            onchange: (e) => {
              if (!e.target.value) return;
              state.customPrompt = e.target.value;
              area.value = e.target.value;
            },
          }, el('option', { value: '' }, '過去に使ったプロンプト…'),
            ...saved.map((p, i) => el('option', { value: p }, `${i + 1}. ${p.slice(0, 40)}`)))
        : null));
  }

  function renderPills() {
    setChildren(pillRow, ...rc.summaries.map((summary) =>
      el('div', {
        class: `summary-pill${summary.id === state.selected ? ' active' : ''}`,
        onclick: (e) => {
          if (e.target.classList.contains('x')) return;
          state.selected = summary.id;
          renderPills();
          renderSelected();
        },
      },
        summary.presetLabel || summary.presetId,
        el('span', { class: 'hint' }, formatDateTime(summary.createdAt)),
        el('span', {
          class: 'x',
          title: '削除',
          onclick: async () => {
            const ok = await confirmDialog('この要約を削除します。', { danger: true, confirmLabel: '削除する' });
            if (!ok) return;
            await api.deleteSummary(rc.job.id, summary.id);
            rc.setSummaries(rc.summaries.filter((s) => s.id !== summary.id));
            if (state.selected === summary.id) state.selected = rc.summaries[0]?.id || null;
            renderPills();
            renderSelected();
          },
        }, '×')),
    ));
    if (!rc.summaries.length) setChildren(pillRow, el('span', { class: 'hint' }, '保存された要約はまだありません'));
  }

  function renderSelected() {
    const summary = rc.summaries.find((s) => s.id === state.selected);
    if (!summary) {
      setChildren(outputHost, el('div', { class: 'empty' },
        el('p', {}, '左のプリセットを選んで「要約を生成」を押してください。'),
        el('p', { class: 'hint' }, '同じ文字起こしから、プリセットを変えて何度でも生成できます。')));
      setChildren(statusHost);
      return;
    }
    setChildren(statusHost,
      el('span', { class: 'badge' }, summary.model),
      summary.pipeline === 'hierarchical'
        ? el('span', { class: 'badge badge-warn', title: '長文のため分割要約→統合を行いました。情報が欠落している可能性があります。' },
            `階層要約（${summary.chunkCount}分割）`)
        : el('span', { class: 'badge' }, '一括要約'),
      summary.usage ? el('span', { class: 'hint' }, `約${summary.usage.jpy}円 / 出力${summary.usage.outputTokens.toLocaleString()}トークン`) : null,
      el('div', { style: 'flex:1' }),
      el('button', { class: 'btn btn-sm', onclick: () => copyToClipboard(summary.body) }, '📋 コピー'),
      el('button', {
        class: 'btn btn-sm',
        onclick: () => {
          window.location.href = api.exportUrl(rc.job.id, { format: 'md', include: 'summary', summaryId: summary.id });
        },
      }, '↓ .md'));
    setChildren(outputHost, markdownNode(summary.body));
  }

  function markdownNode(body) {
    const node = el('div', { class: 'md' });
    node.innerHTML = renderMarkdown(body);
    // 要約中のタイムスタンプから元発言へ遡る
    node.addEventListener('click', (e) => {
      const button = e.target.closest('.ts');
      if (!button) return;
      const sec = parseTimestamp(button.dataset.ts);
      if (sec !== null) rc.seek(sec);
    });
    return node;
  }

  // --- 生成（ストリーミング）--------------------------------------------
  async function generate() {
    if (state.generating) { stream?.abort(); return; }
    const preset = rc.presets.find((p) => p.id === state.presetId);
    if (preset?.custom && !state.customPrompt.trim()) {
      toast('プロンプトを入力してください', 'error');
      return;
    }

    state.generating = true;
    state.selected = null;
    generateButton.textContent = '中止';
    generateButton.classList.remove('btn-primary');
    renderPills();

    const live = el('div', { class: 'md streaming-cursor' });
    setChildren(outputHost, live);
    let text = '';
    let mapTotal = 0;

    const setStatus = (...children) => setChildren(statusHost, ...children);
    setStatus(el('span', { class: 'spinner' }), '準備しています…');

    stream = streamSummary(rc.job.id, {
      presetId: state.presetId,
      customPrompt: state.customPrompt,
      model: state.model,
      effort: state.effort,
    }, {
      start: (event) => setStatus(el('span', { class: 'spinner' }),
        event.pipeline === 'hierarchical'
          ? `階層要約を開始しました（全文 ${event.chars.toLocaleString()}字）`
          : `一括要約を開始しました（全文 ${event.chars.toLocaleString()}字）`),
      map_start: (event) => { mapTotal = event.total; setStatus(el('span', { class: 'spinner' }), `分割要約 0/${mapTotal}`); },
      map_progress: (event) => setStatus(el('span', { class: 'spinner' }), `分割要約 ${event.done}/${event.total}`),
      map_cached: (event) => setStatus(el('span', { class: 'spinner' }),
        `中間要約を再利用します（${event.total}分割・Map段はスキップ）`),
      reduce_start: () => setStatus(el('span', { class: 'spinner' }), '統合しています…'),
      delta: (event) => {
        text += event.text;
        live.innerHTML = renderMarkdown(text);
        live.scrollIntoView?.({ block: 'nearest' });
      },
      done: (event) => {
        rc.setSummaries([event.summary, ...rc.summaries]);
        state.selected = event.summary.id;
        finish();
        renderPills();
        renderSelected();
        notify('要約が完成しました', `${rc.job.title}：${event.summary.presetLabel}`);
      },
      error: (event) => {
        finish();
        setStatus(el('span', { class: 'badge badge-fail' }, '失敗'), event.message);
        toast(event.message, 'error');
      },
    });

    if (preset?.custom) saveCustomPrompt(state.customPrompt);

    try {
      await stream.promise;
    } catch (err) {
      if (err.name !== 'AbortError') {
        toast(err.message, 'error');
        setStatus(el('span', { class: 'badge badge-fail' }, '失敗'), err.message);
      }
      finish();
    }
  }

  function finish() {
    state.generating = false;
    stream = null;
    generateButton.textContent = '要約を生成';
    generateButton.classList.add('btn-primary');
  }

  return {
    destroy() { stream?.abort(); },
  };
}

function loadCustomPrompts() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_PROMPT_KEY) || '[]'); } catch { return []; }
}

function saveCustomPrompt(prompt) {
  const text = prompt.trim();
  if (!text) return;
  const list = [text, ...loadCustomPrompts().filter((p) => p !== text)].slice(0, 20);
  try { localStorage.setItem(CUSTOM_PROMPT_KEY, JSON.stringify(list)); } catch { /* 容量超過は無視 */ }
}
