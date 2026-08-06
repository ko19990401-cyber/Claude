import Anthropic from '@anthropic-ai/sdk';
import { MODEL_PRICES, config } from '../config.js';

let client = null;

export function getClient() {
  if (!config.keys.anthropic) {
    throw Object.assign(
      new Error('ANTHROPIC_API_KEY が設定されていません。.env に追記してサーバを再起動してください。'),
      { status: 503, code: 'NO_ANTHROPIC_KEY' },
    );
  }
  if (!client) {
    client = new Anthropic({ apiKey: config.keys.anthropic, maxRetries: 3 });
  }
  return client;
}

/**
 * モデルごとの対応パラメータ。
 * Claude 5 系は adaptive thinking と effort に対応。Haiku 4.5 は非対応なので送らない。
 */
const CAPABILITIES = {
  'claude-opus-5': { adaptiveThinking: true, effort: true },
  'claude-sonnet-5': { adaptiveThinking: true, effort: true },
  'claude-haiku-4-5': { adaptiveThinking: false, effort: false },
};

export const capabilitiesOf = (model) => CAPABILITIES[model] || { adaptiveThinking: false, effort: false };

export function resolveModel(model) {
  return MODEL_PRICES[model] ? model : config.summaryModel;
}

/** モデルごとの対応状況に合わせてリクエストパラメータを組み立てる。 */
export function buildParams({ model, effort, maxTokens, system, messages }) {
  const caps = capabilitiesOf(model);
  const params = { model, max_tokens: maxTokens, system, messages };
  if (caps.adaptiveThinking) params.thinking = { type: 'adaptive' };
  if (caps.effort) params.output_config = { effort: effort || config.summaryEffort };
  return params;
}

export function usageToJpy(usage, model) {
  const price = MODEL_PRICES[model] || MODEL_PRICES[config.summaryModel];
  const input = usage?.input_tokens || 0;
  const cacheWrite = usage?.cache_creation_input_tokens || 0;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const output = usage?.output_tokens || 0;
  const usd =
    (input / 1e6) * price.input +
    (cacheWrite / 1e6) * price.input * 1.25 +
    (cacheRead / 1e6) * price.input * 0.1 +
    (output / 1e6) * price.output;
  return {
    inputTokens: input,
    cacheWriteTokens: cacheWrite,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    usd: Number(usd.toFixed(5)),
    jpy: Number((usd * config.usdJpy).toFixed(1)),
  };
}

export function mergeUsage(a, b) {
  return {
    inputTokens: (a?.inputTokens || 0) + (b?.inputTokens || 0),
    cacheWriteTokens: (a?.cacheWriteTokens || 0) + (b?.cacheWriteTokens || 0),
    cacheReadTokens: (a?.cacheReadTokens || 0) + (b?.cacheReadTokens || 0),
    outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0),
    usd: Number(((a?.usd || 0) + (b?.usd || 0)).toFixed(5)),
    jpy: Number(((a?.jpy || 0) + (b?.jpy || 0)).toFixed(1)),
  };
}
