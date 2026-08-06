import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 8787),
  dataDir: path.resolve(ROOT, process.env.DATA_DIR || './data'),
  publicDir: path.join(ROOT, 'public'),

  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',

  asrProvider: (process.env.ASR_PROVIDER || 'elevenlabs').toLowerCase(),
  asrLanguage: process.env.ASR_LANGUAGE || 'ja',
  keys: {
    elevenlabs: process.env.ELEVENLABS_API_KEY || '',
    assemblyai: process.env.ASSEMBLYAI_API_KEY || '',
    deepgram: process.env.DEEPGRAM_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
  },

  summaryModel: process.env.SUMMARY_MODEL || 'claude-opus-5',
  summaryEffort: process.env.SUMMARY_EFFORT || 'medium',

  usdJpy: num(process.env.USD_JPY, 150),

  hierarchicalThreshold: num(process.env.HIERARCHICAL_THRESHOLD, 120000),
  chunkChars: num(process.env.CHUNK_CHARS, 20000),
  chunkOverlapChars: num(process.env.CHUNK_OVERLAP_CHARS, 400),
  mapConcurrency: num(process.env.MAP_CONCURRENCY, 4),

  // 音声分割フォールバックの閾値（FR-03）
  silenceThresholdDb: -35,
  silenceMinDurSec: 0.7,
  chunkOverlapSec: 5,
};

export const paths = {
  jobs: path.join(config.dataDir, 'jobs'),
  audio: path.join(config.dataDir, 'audio'),
  uploads: path.join(config.dataDir, 'uploads'),
  glossaries: path.join(config.dataDir, 'glossaries'),
  tmp: path.join(config.dataDir, 'tmp'),
};

/** LLMのトークン単価（USD / 1M tokens）。コスト試算に使用。 */
export const MODEL_PRICES = {
  'claude-opus-5': { input: 5, output: 25, label: 'Claude Opus 5（既定・最高精度）' },
  'claude-sonnet-5': { input: 3, output: 15, label: 'Claude Sonnet 5（速度と精度の均衡）' },
  'claude-haiku-4-5': { input: 1, output: 5, label: 'Claude Haiku 4.5（安価・短い要約向け）' },
};

export const SUPPORTED_EXTENSIONS = [
  '.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus', '.mp4', '.mov',
];
