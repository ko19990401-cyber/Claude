import fs from 'node:fs';
import fsp from 'node:fs/promises';

/** 通信失敗時の指数バックオフ再試行（§11 / FR-11：3回まで）。 */
export async function withRetry(fn, { retries = 3, baseMs = 2000, onRetry, label = 'request' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (err?.fatal || attempt === retries) break;
      const waitMs = baseMs * 2 ** attempt;
      onRetry?.({ attempt: attempt + 1, retries, waitMs, error: err, label });
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastError;
}

/** ステータスが4xx（レート制限を除く）なら再試行しても無駄なので fatal を立てる。 */
export function httpError(status, body, provider) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const err = new Error(`${provider} API エラー (HTTP ${status}): ${String(text).slice(0, 500)}`);
  err.status = status;
  err.fatal = status >= 400 && status < 500 && status !== 429 && status !== 408;
  return err;
}

/** 大きなファイルをメモリに載せずに multipart で送るための Blob を作る。 */
export async function fileBlob(filePath, type = 'application/octet-stream') {
  if (typeof fs.openAsBlob === 'function') {
    return fs.openAsBlob(filePath, { type });
  }
  const buf = await fsp.readFile(filePath);
  return new Blob([buf], { type });
}

export const SPEAKER_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * ベンダー固有の話者ID（speaker_0 / A / 1 など）を A, B, C… に正規化する。
 * 出現順にラベルを割り当てるので、UI 上で「話者A」が最初の発言者になる。
 */
export function createSpeakerMapper() {
  const map = new Map();
  return (raw) => {
    const key = raw === undefined || raw === null ? 'unknown' : String(raw);
    if (!map.has(key)) {
      const idx = map.size;
      map.set(
        key,
        idx < SPEAKER_ALPHABET.length
          ? SPEAKER_ALPHABET[idx]
          : `S${idx + 1}`,
      );
    }
    return map.get(key);
  };
}

/**
 * 単語列を発話セグメントへまとめる。
 * 話者交代・文末・一定の無音・長さ上限のいずれかで区切る（§3 セグメント定義）。
 */
export function groupWords(words, { maxGapSec = 1.2, maxChars = 140 } = {}) {
  const segments = [];
  let current = null;
  const flush = () => {
    if (current && current.text.trim()) {
      current.text = current.text.trim();
      segments.push(current);
    }
    current = null;
  };

  for (const w of words) {
    const text = w.text ?? '';
    if (!text) continue;
    const gap = current ? w.start - current.end : 0;
    const sentenceEnd = current && /[。．！？!?]\s*$/.test(current.text);
    const tooLong = current && current.text.length >= maxChars;
    if (!current || current.speakerId !== w.speakerId || gap > maxGapSec || sentenceEnd || tooLong) {
      flush();
      current = {
        start: w.start,
        end: w.end,
        speakerId: w.speakerId,
        text: '',
        confidence: w.confidence ?? null,
        confidenceCount: 0,
      };
    }
    // 日本語は分かち書きしないので、前後がASCIIのときだけ空白を入れる
    const needsSpace =
      current.text &&
      /[\w)\]'"]$/.test(current.text) &&
      /^[\w([$'"]/.test(text);
    current.text += (needsSpace ? ' ' : '') + text;
    current.end = w.end;
    if (typeof w.confidence === 'number') {
      const n = current.confidenceCount;
      current.confidence = ((current.confidence ?? w.confidence) * n + w.confidence) / (n + 1);
      current.confidenceCount = n + 1;
    }
  }
  flush();
  return segments.map(({ confidenceCount, ...seg }) => seg);
}

/** セグメント配列に連番IDを振り、話者一覧を集計する。 */
export function finalizeSegments(segments, { idOffset = 0 } = {}) {
  const speakers = new Map();
  const out = segments
    .filter((s) => s.text && s.text.trim())
    .map((s, i) => {
      const id = `seg_${String(idOffset + i + 1).padStart(4, '0')}`;
      const speakerId = s.speakerId || 'A';
      const agg = speakers.get(speakerId) || { id: speakerId, label: `話者${speakerId}`, utteranceCount: 0, totalSec: 0 };
      agg.utteranceCount += 1;
      agg.totalSec += Math.max(0, s.end - s.start);
      speakers.set(speakerId, agg);
      return {
        id,
        start: Number(s.start.toFixed(2)),
        end: Number(s.end.toFixed(2)),
        speakerId,
        text: s.text.trim(),
        confidence: s.confidence == null ? null : Number(s.confidence.toFixed(3)),
        edited: false,
      };
    });
  const speakerList = [...speakers.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ ...s, totalSec: Number(s.totalSec.toFixed(1)) }));
  return { segments: out, speakers: speakerList };
}
