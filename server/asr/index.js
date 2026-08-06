import { config } from '../config.js';
import { assemblyai } from './assemblyai.js';
import { deepgram } from './deepgram.js';
import { elevenlabs } from './elevenlabs.js';

/**
 * ASRエンジン層。§7.2 の方針どおり、差し替え可能な抽象化にしてある。
 * 新しいベンダーを足すときは submit/poll を実装して ENGINES に登録するだけでよい。
 */
export const ENGINES = {
  [elevenlabs.id]: elevenlabs,
  [assemblyai.id]: assemblyai,
  [deepgram.id]: deepgram,
};

export function getEngine(id = config.asrProvider) {
  const engine = ENGINES[id];
  if (!engine) {
    throw Object.assign(new Error(`未知のASRプロバイダです: ${id}`), { status: 400 });
  }
  return engine;
}

export function listEngines() {
  return Object.values(ENGINES).map((e) => ({
    id: e.id,
    label: e.label,
    mode: e.mode,
    usdPerMinute: e.usdPerMinute,
    supportsBoost: e.supportsBoost,
    boostNote: e.boostNote,
    configured: e.isConfigured(),
    isDefault: e.id === config.asrProvider,
  }));
}
