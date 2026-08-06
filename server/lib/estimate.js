import { MODEL_PRICES, config } from '../config.js';
import { getEngine } from '../asr/index.js';

/**
 * FR-01 の「推定処理時間」「推定コスト」。POST /api/estimate から呼ぶ。
 *
 * 数値はあくまで概算。実測でずれるので UI 側にも概算である旨を出す。
 */
export function estimate({ durationSec, fileBytes = 0, provider = config.asrProvider, model = config.summaryModel }) {
  const minutes = durationSec / 60;
  const engine = getEngine(provider);
  const rate = config.usdJpy;

  const asrUsd = minutes * engine.usdPerMinute;

  // 日本語会議の目安：1分あたり約350字、1トークン約1.3字
  const transcriptChars = Math.round(minutes * 350);
  const inputTokens = Math.round(transcriptChars / 1.3) + 800;
  const outputTokens = Math.min(4000, Math.max(700, Math.round(transcriptChars * 0.06)));
  const price = MODEL_PRICES[model] || MODEL_PRICES[config.summaryModel];
  const llmUsd = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

  // 前処理はffmpegの実測で概ね実時間の1/60。文字起こしはエンジンのスループット依存。
  const preprocessSec = Math.max(5, durationSec / 60);
  const transcribeSec = Math.max(20, durationSec / (engine.realtimeFactor || 15));
  const summarySec = Math.max(15, outputTokens / 25);

  return {
    durationSec,
    fileBytes,
    provider: engine.id,
    providerLabel: engine.label,
    model,
    modelLabel: price.label,
    transcriptChars,
    cost: {
      asrJpy: round(asrUsd * rate),
      summaryJpy: round(llmUsd * rate),
      totalJpy: round((asrUsd + llmUsd) * rate),
      asrUsd: round(asrUsd, 4),
      summaryUsd: round(llmUsd, 4),
      usdJpy: rate,
    },
    time: {
      preprocessSec: Math.round(preprocessSec),
      transcribeSec: Math.round(transcribeSec),
      summarySec: Math.round(summarySec),
      totalSec: Math.round(preprocessSec + transcribeSec),
    },
    estimatedProcessedBytes: Math.round(durationSec * 3000), // 24kbps ≒ 3KB/秒
    willChunk: Math.round(durationSec * 3000) > engine.maxUploadBytes,
    hierarchical: transcriptChars > config.hierarchicalThreshold,
  };
}

const round = (n, digits = 1) => Number(n.toFixed(digits));
