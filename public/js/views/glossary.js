import { api } from '../api.js';
import {
  confirmDialog, el, setChildren, toast,
} from '../util.js';

/**
 * FR-05 用語辞書エディタ。
 * 1段目（ASRのカスタム語彙）と2段目（置換辞書）を1画面で編集する。
 */
export async function openGlossary({ jobId = null, glossaryId = 'glo_default', rc = null } = {}) {
  let glossary;
  try {
    glossary = (await api.getGlossary(glossaryId || 'glo_default')).glossary;
  } catch {
    glossary = (await api.getGlossary('glo_default')).glossary;
  }

  const boost = [...glossary.boost];
  const replace = glossary.replace.map((r) => ({ ...r }));

  const boostHost = el('div', { class: 'tag-input' });
  const replaceHost = el('div', { class: 'kv-list' });

  const engineNote = rc?.system?.activeEngine && !rc.system.activeEngine.supportsBoost
    ? el('p', { class: 'hint' }, `${rc.system.activeEngine.label} はカスタム語彙に非対応のため、1段目は次回以降のエンジン切替時に使われます。2段目の置換は常に有効です。`)
    : null;

  function renderBoost() {
    const input = el('input', {
      placeholder: '用語を入力して Enter',
      onkeydown: (e) => {
        if (e.key === 'Enter' && e.target.value.trim()) {
          e.preventDefault();
          boost.push(e.target.value.trim());
          e.target.value = '';
          renderBoost();
          boostHost.querySelector('input').focus();
        }
        if (e.key === 'Backspace' && !e.target.value && boost.length) {
          boost.pop();
          renderBoost();
          boostHost.querySelector('input').focus();
        }
      },
    });
    setChildren(boostHost,
      ...boost.map((term, i) => el('span', { class: 'tag' }, term,
        el('button', { title: '削除', onclick: () => { boost.splice(i, 1); renderBoost(); } }, '×'))),
      input);
  }

  function renderReplace() {
    setChildren(replaceHost, ...replace.map((rule, i) =>
      el('div', { class: 'kv-row' },
        el('input', {
          class: 'input', value: rule.from, placeholder: '誤り',
          oninput: (e) => { rule.from = e.target.value; },
        }),
        el('span', { class: 'arrow' }, '→'),
        el('input', {
          class: 'input', value: rule.to, placeholder: '正',
          oninput: (e) => { rule.to = e.target.value; },
        }),
        el('label', { class: 'toggle', title: '正規表現として扱う' },
          el('input', { type: 'checkbox', checked: rule.regex, onchange: (e) => { rule.regex = e.target.checked; } }),
          '正規表現'),
        el('button', {
          class: 'btn btn-ghost btn-sm',
          onclick: () => { replace.splice(i, 1); renderReplace(); },
        }, '🗑'))));
  }

  renderBoost();
  renderReplace();

  const applyRow = jobId
    ? el('div', { style: 'display:flex;gap:8px' },
        el('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            try {
              await save();
              const result = await api.applyGlossary(jobId, glossary.id);
              rc?.setSegments(result.segments);
              await rc?.refreshJob();
              window.dispatchEvent(new CustomEvent('segments-changed'));
              toast(`${result.count}箇所を置換しました`, 'ok');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'この文字起こしに適用'),
        el('button', {
          class: 'btn btn-sm',
          onclick: async () => {
            try {
              const result = await api.revertGlossary(jobId);
              rc?.setSegments(result.segments);
              await rc?.refreshJob();
              window.dispatchEvent(new CustomEvent('segments-changed'));
              toast(`${result.reverted}件の置換を取り消しました`, 'ok');
            } catch (err) { toast(err.message, 'error'); }
          },
        }, '直前の置換を取り消す'))
    : null;

  const backdrop = el('div', {
    class: 'modal-backdrop',
    onclick: (e) => { if (e.target === backdrop) close(); },
  },
    el('div', { class: 'modal' },
      el('header', {}, el('h3', {}, '用語辞書'), el('button', { class: 'btn btn-ghost btn-sm', onclick: () => close() }, '×')),
      el('div', { class: 'content' },
        el('div', { class: 'field' },
          el('label', {}, '辞書名'),
          el('input', { class: 'input', value: glossary.name, oninput: (e) => { glossary.name = e.target.value; } })),
        el('div', { class: 'field' },
          el('label', {}, '1段目：カスタム語彙（固有名詞・専門用語）'),
          el('div', { class: 'hint' }, '文字起こし前にASRへ渡し、認識そのものを補正します。100語程度までを目安に。'),
          boostHost,
          engineNote),
        el('div', { class: 'field' },
          el('label', {}, '2段目：置換辞書（誤り → 正）'),
          el('div', { class: 'hint' }, '文字起こし後に適用します。1段目で拾えない表記ゆれを吸収します。'),
          replaceHost,
          el('button', {
            class: 'btn btn-sm',
            onclick: () => { replace.push({ from: '', to: '', regex: false }); renderReplace(); },
          }, '＋ 置換ルールを追加')),
        applyRow),
      el('footer', {},
        el('span', { class: 'hint grow' }, '保存した辞書は次回以降のジョブにも引き継がれます'),
        el('button', { class: 'btn', onclick: () => close() }, '閉じる'),
        el('button', {
          class: 'btn btn-primary',
          onclick: async () => {
            try { await save(); toast('辞書を保存しました', 'ok'); } catch (err) { toast(err.message, 'error'); }
          },
        }, '保存'))));

  document.body.append(backdrop);
  boostHost.querySelector('input')?.focus();

  async function save() {
    const cleaned = replace.filter((r) => r.from.trim());
    const result = await api.saveGlossary(glossary.id, {
      name: glossary.name,
      boost: boost.filter(Boolean),
      replace: cleaned,
    });
    glossary = result.glossary;
  }

  function close() { backdrop.remove(); }
}
