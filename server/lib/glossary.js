/**
 * FR-05 用語辞書の2段目：文字起こし後の置換辞書。
 * 完全一致と正規表現の双方に対応し、取り消せるように変更前テキストを記録する。
 */

function buildMatcher(rule) {
  if (!rule?.from) return null;
  if (rule.regex) {
    try {
      return new RegExp(rule.from, rule.flags || 'g');
    } catch {
      return null; // 不正な正規表現は無視する（UI側でも検証する）
    }
  }
  const escaped = rule.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'g');
}

/**
 * @returns {{segments: object[], changes: object[], count: number}}
 *   changes は取り消し用のスナップショット（segmentId と before）。
 */
export function applyGlossary(segments, glossary) {
  const rules = (glossary?.replace || [])
    .map((rule) => ({ rule, matcher: buildMatcher(rule) }))
    .filter((r) => r.matcher);
  if (!rules.length) return { segments, changes: [], count: 0 };

  const changes = [];
  let count = 0;

  const next = segments.map((seg) => {
    let text = seg.text;
    const applied = [];
    for (const { rule, matcher } of rules) {
      matcher.lastIndex = 0;
      const hits = text.match(matcher);
      if (!hits?.length) continue;
      text = text.replace(matcher, rule.to ?? '');
      applied.push({ from: rule.from, to: rule.to, hits: hits.length });
      count += hits.length;
    }
    if (!applied.length) return seg;
    changes.push({ segmentId: seg.id, before: seg.text, after: text, rules: applied });
    return { ...seg, text };
  });

  return { segments: next, changes, count };
}

/** 置換の取り消し。記録した before に戻す。 */
export function revertGlossary(segments, changes) {
  const byId = new Map(changes.map((c) => [c.segmentId, c.before]));
  let reverted = 0;
  const next = segments.map((seg) => {
    if (!byId.has(seg.id)) return seg;
    reverted += 1;
    return { ...seg, text: byId.get(seg.id) };
  });
  return { segments: next, reverted };
}
