import fs from 'node:fs';
import { ENGINES } from '../server/asr/index.js';
import { finalizeSegments } from '../server/asr/util.js';
import { probeDuration } from './helpers.mjs';

/**
 * テスト用のASRエンジン。実APIを叩かずにパイプライン全体を通すために使う。
 * `ASR_PROVIDER=mock` で選択される。
 */
export function installMockEngine({ maxUploadBytes = 900 * 1024 * 1024, segments } = {}) {
  const calls = [];
  ENGINES.mock = {
    id: 'mock',
    label: 'Mock ASR',
    mode: 'sync',
    model: 'mock-v1',
    maxUploadBytes,
    usdPerMinute: 0.004,
    realtimeFactor: 20,
    supportsBoost: true,
    isConfigured: () => true,
    async submit({ filePath, boost }) {
      const duration = probeDuration(filePath);
      calls.push({ bytes: fs.statSync(filePath).size, duration, boost });
      const index = calls.length - 1;
      return {
        externalJobId: `mock_${index}`,
        result: finalizeSegments(segments ? segments(index, duration) : defaultSegments(index, duration)),
      };
    },
    async poll() {
      return { status: 'completed' };
    },
  };
  return calls;
}

const defaultSegments = (index, duration) => [
  {
    start: 0.4,
    end: Math.min(6.1, duration / 3),
    speakerId: 'A',
    text: '本日の議題はエルゴワン接続の進捗についてです。',
    confidence: 0.94,
  },
  {
    start: Math.min(6.3, duration / 3 + 0.2),
    end: Math.min(12.0, (duration / 3) * 2),
    speakerId: 'B',
    text: 'ガバメントクラウト移行のスケジュールを確認したいのですが。',
    confidence: 0.55,
  },
  {
    start: Math.min(12.2, (duration / 3) * 2 + 0.2),
    end: Math.max(duration - 0.5, 12.4),
    speakerId: 'A',
    text: '来年3月末までに完了予定です。ビーピーアールも並行して進めます。',
    confidence: 0.91,
  },
];
