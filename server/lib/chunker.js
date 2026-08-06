import { config } from '../config.js';

/**
 * FR-03 の分割フォールバック。
 *
 * 原則は「分割しない」。API上限を超えるときだけ、無音区間を境界に切る。
 * 単語の途中で切らないよう境界は無音の中央に置き、前後に overlapSec の
 * のりしろを持たせて、重複テキストの照合と話者ラベル対応付けに使う。
 */
export function planChunks({ durationSec, totalBytes, maxBytes, silences = [], overlapSec = config.chunkOverlapSec }) {
  if (totalBytes <= maxBytes || durationSec <= 0) {
    return [{ index: 0, start: 0, end: durationSec, coreStart: 0, coreEnd: durationSec, overlapBefore: 0, overlapAfter: 0 }];
  }

  // 送信する各チャンクは「本体＋前後ののりしろ」なので、のりしろ込みで上限に収める。
  const bytesPerSec = totalBytes / durationSec;
  const budgetSec = (maxBytes * 0.9) / bytesPerSec;
  // 上限が小さくてのりしろが取れない場合は、のりしろ自体を縮める
  const overlap = Math.max(1, Math.min(overlapSec, budgetSec * 0.15));
  const coreSec = Math.max(5, budgetSec - overlap * 2);
  const chunkCount = Math.max(2, Math.ceil(durationSec / coreSec));

  const targets = [];
  for (let i = 1; i < chunkCount; i += 1) targets.push((durationSec * i) / chunkCount);

  // 無音へ寄せた結果チャンクが極端に短くならないよう、最小間隔を設ける
  const minGap = Math.max(overlap, (durationSec / chunkCount) * 0.3);
  const cuts = [];
  for (const target of targets) {
    const nearest = nearestSilenceCenter(silences, target, durationSec / chunkCount / 2);
    const cut = nearest ?? target;
    if (cuts.length === 0 || cut - cuts[cuts.length - 1] > minGap) cuts.push(cut);
  }

  const bounds = [0, ...cuts, durationSec];
  const chunks = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const rawStart = bounds[i];
    const rawEnd = bounds[i + 1];
    const overlapBefore = i === 0 ? 0 : Math.min(overlap, rawStart);
    const overlapAfter = i === bounds.length - 2 ? 0 : Math.min(overlap, durationSec - rawEnd);
    chunks.push({
      index: i,
      // 実際に切り出す範囲（のりしろ込み）
      start: rawStart - overlapBefore,
      end: rawEnd + overlapAfter,
      // 採用する範囲（のりしろを除いた本体）
      coreStart: rawStart,
      coreEnd: rawEnd,
      overlapBefore,
      overlapAfter,
    });
  }
  return chunks;
}

function nearestSilenceCenter(silences, target, maxDistance) {
  let best = null;
  let bestDistance = Infinity;
  for (const s of silences) {
    const center = (s.start + s.end) / 2;
    const distance = Math.abs(center - target);
    if (distance < bestDistance && distance <= maxDistance) {
      best = center;
      bestDistance = distance;
    }
  }
  return best;
}

const normalize = (text) => text.replace(/[\s、。,.]/g, '');

/**
 * 分割送信した結果を1本に繋ぎ直す。
 *  1. のりしろ区間のテキスト一致で重複セグメントを除去
 *  2. のりしろ区間の話者を突き合わせてラベル対応表を作り、後続チャンクを付け替える
 *
 * ASRはチャンクごとに独立して話者ラベルを振り直すため、
 * 「チャンク1の話者A」と「チャンク2の話者A」は別人になりうる。
 * チャンク内のラベルはそのまま使わず、必ず全体ラベルへ写像し直す。
 */
export function mergeChunkResults(chunkResults) {
  const merged = [];
  const knownLabels = []; // 全体で確定した話者ラベル（出現順）

  chunkResults.forEach((chunk, chunkIndex) => {
    const offset = chunk.start;
    const segments = chunk.result.segments.map((seg) => ({
      ...seg,
      start: seg.start + offset,
      end: seg.end + offset,
    }));

    if (chunkIndex === 0) {
      for (const s of segments) if (!knownLabels.includes(s.speakerId)) knownLabels.push(s.speakerId);
      merged.push(...segments);
      return;
    }

    // --- 1. 重複除去 --------------------------------------------------
    const overlapStart = chunk.coreStart - chunk.overlapBefore;
    const overlapEnd = chunk.coreStart;
    const previousInOverlap = merged.filter((s) => s.end > overlapStart && s.start < overlapEnd + 1);
    const currentInOverlap = segments.filter((s) => s.start < overlapEnd);

    const previousTexts = new Set(previousInOverlap.map((s) => normalize(s.text)));
    const deduped = segments.filter((s) => !(s.start < overlapEnd && previousTexts.has(normalize(s.text))));

    // --- 2. 話者ラベルの対応付け ---------------------------------------
    // (a) のりしろ区間で同じ発言／時間帯が重なる発言を突き合わせる
    const localToGlobal = new Map();
    const taken = new Set();
    for (const cur of currentInOverlap) {
      if (localToGlobal.has(cur.speakerId)) continue;
      const key = normalize(cur.text);
      const match = previousInOverlap.find((p) => normalize(p.text) === key)
        || previousInOverlap.find((p) => overlaps(p, cur));
      if (match && !taken.has(match.speakerId)) {
        localToGlobal.set(cur.speakerId, match.speakerId);
        taken.add(match.speakerId);
      }
    }

    // (b) 突き合わせできなかった話者は、未使用の既存ラベルへ出現順に割り当てる。
    //     既存ラベルを使い切ったら新しいラベルを採番する。
    //     ここは推測が入るため、呼び出し側で警告バッジを出すこと（FR-03）。
    for (const seg of deduped) {
      if (localToGlobal.has(seg.speakerId)) continue;
      const free = knownLabels.find((label) => !taken.has(label));
      const assigned = free ?? nextLabel(knownLabels);
      localToGlobal.set(seg.speakerId, assigned);
      taken.add(assigned);
      if (!knownLabels.includes(assigned)) knownLabels.push(assigned);
    }

    merged.push(...deduped.map((s) => ({ ...s, speakerId: localToGlobal.get(s.speakerId) ?? s.speakerId })));
  });

  merged.sort((a, b) => a.start - b.start);
  return merged;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function nextLabel(knownLabels) {
  for (const letter of ALPHABET) {
    if (!knownLabels.includes(letter)) return letter;
  }
  return `S${knownLabels.length + 1}`;
}

const overlaps = (a, b) => Math.min(a.end, b.end) - Math.max(a.start, b.start) > 0.3;
