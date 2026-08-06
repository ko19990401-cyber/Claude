/** FR-09 エクスポート。md / txt / srt / vtt を生成する。 */

export function formatTimestamp(sec, { ms = false, comma = false } = {}) {
  const total = Math.max(0, sec || 0);
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(Math.floor(total % 60)).padStart(2, '0');
  if (!ms) return `${h}:${m}:${s}`;
  const frac = String(Math.floor((total % 1) * 1000)).padStart(3, '0');
  return `${h}:${m}:${s}${comma ? ',' : '.'}${frac}`;
}

const speakerLabel = (speakers, id) => speakers.find((s) => s.id === id)?.label || `話者${id}`;

export function toMarkdown({ job, segments, speakers, summaries = [], includeTimestamps = true }) {
  const lines = [`# ${job.title}`, ''];
  lines.push(`- 作成日時: ${new Date(job.createdAt).toLocaleString('ja-JP')}`);
  lines.push(`- 元ファイル: ${job.source.fileName}`);
  lines.push(`- 長さ: ${formatTimestamp(job.source.durationSec)}`);
  lines.push(`- 話者数: ${speakers.length}`);
  lines.push(`- エンジン: ${job.engine.provider} / ${job.engine.model}`);
  if (job.engine.wasChunked) lines.push('- ⚠ 音声を分割して処理しました（話者の対応付けに誤りが含まれる可能性があります）');
  lines.push('');

  for (const summary of summaries) {
    lines.push(`## 要約：${summary.presetLabel || summary.presetId}`, '');
    lines.push(summary.body.trim(), '');
  }

  lines.push('## 文字起こし', '');
  let lastSpeaker = null;
  for (const seg of segments) {
    const label = speakerLabel(speakers, seg.speakerId);
    const head = includeTimestamps ? `**[${formatTimestamp(seg.start)}] ${label}**` : `**${label}**`;
    if (label !== lastSpeaker || includeTimestamps) lines.push(head);
    lines.push(seg.text, '');
    lastSpeaker = label;
  }
  return lines.join('\n');
}

export function toPlainText({ segments, speakers, includeTimestamps = true }) {
  return segments
    .map((seg) => {
      const label = speakerLabel(speakers, seg.speakerId);
      return includeTimestamps
        ? `[${formatTimestamp(seg.start)}] ${label}: ${seg.text}`
        : `${label}: ${seg.text}`;
    })
    .join('\n');
}

export function toSrt({ segments, speakers }) {
  return segments
    .map((seg, i) => {
      const label = speakerLabel(speakers, seg.speakerId);
      return [
        i + 1,
        `${formatTimestamp(seg.start, { ms: true, comma: true })} --> ${formatTimestamp(seg.end, { ms: true, comma: true })}`,
        `${label}: ${seg.text}`,
        '',
      ].join('\n');
    })
    .join('\n');
}

export function toVtt({ segments, speakers }) {
  const body = segments
    .map((seg) => {
      const label = speakerLabel(speakers, seg.speakerId);
      return [
        `${formatTimestamp(seg.start, { ms: true })} --> ${formatTimestamp(seg.end, { ms: true })}`,
        `<v ${label}>${seg.text}`,
        '',
      ].join('\n');
    })
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

export const EXPORT_FORMATS = {
  md: { ext: 'md', mime: 'text/markdown; charset=utf-8', label: 'Markdown' },
  txt: { ext: 'txt', mime: 'text/plain; charset=utf-8', label: 'プレーンテキスト' },
  srt: { ext: 'srt', mime: 'application/x-subrip; charset=utf-8', label: 'SRT字幕' },
  vtt: { ext: 'vtt', mime: 'text/vtt; charset=utf-8', label: 'WebVTT字幕' },
};

export function renderExport(format, data) {
  switch (format) {
    case 'md': return toMarkdown(data);
    case 'txt': return toPlainText(data);
    case 'srt': return toSrt(data);
    case 'vtt': return toVtt(data);
    default: throw Object.assign(new Error(`未対応の形式です: ${format}`), { status: 400 });
  }
}
