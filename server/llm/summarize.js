import crypto from 'node:crypto';
import { config } from '../config.js';
import { formatTimestamp } from '../lib/exporters.js';
import { getIntermediate, saveIntermediate } from '../lib/store.js';
import { buildParams, getClient, mergeUsage, resolveModel, usageToJpy } from './client.js';
import { COMMON_RULES, MAP_INSTRUCTION, REDUCE_PREFIX, getPreset } from './presets.js';

/** LLMに渡す文字起こしの整形。要約にタイムスタンプを引かせるため必ず時刻を添える。 */
export function renderTranscript(segments, speakers) {
  const labels = new Map(speakers.map((s) => [s.id, s.label]));
  return segments
    .map((s) => `[${formatTimestamp(s.start)}] ${labels.get(s.speakerId) || `話者${s.speakerId}`}: ${s.text}`)
    .join('\n');
}

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);

function instructionFor(presetId, customPrompt) {
  const preset = getPreset(presetId);
  if (!preset) throw Object.assign(new Error(`未知のプリセットです: ${presetId}`), { status: 400 });
  if (preset.custom) {
    const text = (customPrompt || '').trim();
    if (!text) throw Object.assign(new Error('自由記述プリセットではプロンプトの入力が必要です。'), { status: 400 });
    return { preset, instruction: text };
  }
  return { preset, instruction: preset.instruction };
}

/**
 * 話者ターン境界を尊重しつつ、約 chunkChars ごとに区切る（FR-08 ①）。
 * 前チャンク末尾 overlapChars 分を先頭に付与して文脈の断絶を防ぐ。
 */
export function splitForMap(transcript, { chunkChars = config.chunkChars, overlapChars = config.chunkOverlapChars } = {}) {
  const lines = transcript.split('\n');
  const chunks = [];
  let buffer = [];
  let length = 0;

  const flush = () => {
    if (!buffer.length) return;
    const body = buffer.join('\n');
    const previous = chunks[chunks.length - 1]?.body || '';
    const overlap = previous.slice(-overlapChars);
    chunks.push({
      index: chunks.length,
      body,
      text: overlap ? `（前の部分の末尾）\n${overlap}\n（ここから本文）\n${body}` : body,
      rangeSec: [timeOf(buffer[0]), timeOf(buffer[buffer.length - 1])],
    });
    buffer = [];
    length = 0;
  };

  for (const line of lines) {
    if (length + line.length > chunkChars && buffer.length) flush();
    buffer.push(line);
    length += line.length + 1;
  }
  flush();
  return chunks;
}

function timeOf(line) {
  const m = /^\[(\d\d):(\d\d):(\d\d)\]/.exec(line || '');
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
}

/**
 * 要約を生成する。
 *
 * - 全文が閾値以下 → 一括要約（1回のAPI呼び出し）
 * - 超える場合 → 階層要約（Map → Reduce）。中間要約は保存し、
 *   プリセットだけ変えた再生成では Map を再実行しない（FR-08）。
 *
 * @param onEvent  進捗とストリーミング差分を受け取るコールバック
 */
export async function generateSummary({
  job,
  segments,
  speakers,
  presetId,
  customPrompt,
  model: requestedModel,
  effort,
  forceRemap = false,
  onEvent = () => {},
  signal,
}) {
  const model = resolveModel(requestedModel);
  const { preset, instruction } = instructionFor(presetId, customPrompt);
  const transcript = renderTranscript(segments, speakers);
  const useHierarchical = transcript.length > config.hierarchicalThreshold;

  onEvent({
    type: 'start',
    pipeline: useHierarchical ? 'hierarchical' : 'single',
    model,
    chars: transcript.length,
  });

  const result = useHierarchical
    ? await hierarchical({ job, transcript, instruction, model, effort, forceRemap, onEvent, signal })
    : await single({ transcript, instruction, model, effort, onEvent, signal });

  return {
    id: `sum_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    presetId,
    presetLabel: preset.label,
    customPrompt: preset.custom ? customPrompt : undefined,
    model,
    effort: effort || config.summaryEffort,
    pipeline: useHierarchical ? 'hierarchical' : 'single',
    createdAt: new Date().toISOString(),
    body: result.body,
    usage: result.usage,
    chunkCount: result.chunkCount,
  };
}

/** 一括要約。文字起こし全文をキャッシュ対象に置き、プリセット指示を後ろに付ける。 */
async function single({ transcript, instruction, model, effort, onEvent, signal }) {
  const params = buildParams({
    model,
    effort,
    maxTokens: 16000,
    system: [{ type: 'text', text: COMMON_RULES }],
    messages: [
      {
        role: 'user',
        content: [
          // 文字起こしはプリセットを変えても不変なので、ここでキャッシュを切る。
          // プリセット違いの再生成が入力側ほぼ無料になる。
          {
            type: 'text',
            text: `# 文字起こし全文\n\n${transcript}`,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: `# 指示\n\n${instruction}` },
        ],
      },
    ],
  });

  const { text, usage } = await streamText(params, onEvent, signal);
  return { body: text, usage: usageToJpy(usage, model), chunkCount: 1 };
}

/** 階層要約。②Map（並列・中間要約はキャッシュ） → ③Reduce（ストリーミング）。 */
async function hierarchical({ job, transcript, instruction, model, effort, forceRemap, onEvent, signal }) {
  const transcriptHash = hashOf(transcript);
  let stored = await getIntermediate(job.id);
  let usage = null;

  if (forceRemap || !stored || stored.transcriptHash !== transcriptHash) {
    const chunks = splitForMap(transcript);
    onEvent({ type: 'map:start', total: chunks.length });

    const results = new Array(chunks.length);
    let done = 0;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(config.mapConcurrency, chunks.length) }, async () => {
      while (cursor < chunks.length) {
        const chunk = chunks[cursor++];
        const params = buildParams({
          model,
          effort: 'low', // 事実抽出に深い推論は要らない。コストと待ち時間を抑える。
          maxTokens: 8000,
          system: [{ type: 'text', text: COMMON_RULES }],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `# 文字起こし（第${chunk.index + 1}部 / 全${chunks.length}部）\n\n${chunk.text}` },
                { type: 'text', text: `# 指示\n\n${MAP_INSTRUCTION}` },
              ],
            },
          ],
        });
        const res = await getClient().messages.create(params, { signal });
        const body = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        results[chunk.index] = { chunkIndex: chunk.index, rangeSec: chunk.rangeSec, body };
        usage = mergeUsage(usage, usageToJpy(res.usage, model));
        done += 1;
        onEvent({ type: 'map:progress', done, total: chunks.length });
      }
    });
    await Promise.all(workers);

    stored = { transcriptHash, createdAt: new Date().toISOString(), model, chunks: results };
    await saveIntermediate(job.id, stored);
  } else {
    onEvent({ type: 'map:cached', total: stored.chunks.length });
  }

  onEvent({ type: 'reduce:start', total: stored.chunks.length });
  const combined = stored.chunks
    .map((c) => `## 第${c.chunkIndex + 1}部（${formatTimestamp(c.rangeSec[0])}〜${formatTimestamp(c.rangeSec[1])}）\n${c.body}`)
    .join('\n\n');

  const params = buildParams({
    model,
    effort,
    maxTokens: 16000,
    system: [{ type: 'text', text: COMMON_RULES }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${REDUCE_PREFIX}\n\n# 抽出済みの事実一覧\n\n${combined}`,
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: `# 指示\n\n${instruction}` },
        ],
      },
    ],
  });

  const { text, usage: reduceUsage } = await streamText(params, onEvent, signal);
  return {
    body: text,
    usage: mergeUsage(usage, usageToJpy(reduceUsage, model)),
    chunkCount: stored.chunks.length,
  };
}

/** ストリーミングでテキストを受け取りつつ、差分を onEvent に流す。 */
async function streamText(params, onEvent, signal) {
  const stream = getClient().messages.stream(params, { signal });
  stream.on('text', (delta) => onEvent({ type: 'delta', text: delta }));
  const message = await stream.finalMessage();
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  if (message.stop_reason === 'refusal') {
    throw Object.assign(new Error('モデルが応答を拒否しました。プロンプトの内容を確認してください。'), { status: 422 });
  }
  return { text, usage: message.usage };
}
