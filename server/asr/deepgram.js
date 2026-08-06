import fs from 'node:fs';
import { config } from '../config.js';
import { createSpeakerMapper, finalizeSegments, groupWords, httpError, withRetry } from './util.js';

const BASE = 'https://api.deepgram.com/v1/listen';

/**
 * Deepgram Nova-3（対抗馬）。処理速度が速い。
 * 同期APIで、音声はリクエストボディにそのまま流し込む。
 */
export const deepgram = {
  id: 'deepgram',
  label: 'Deepgram Nova-3',
  mode: 'sync',
  model: 'nova-3',
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  usdPerMinute: 0.0068, // 文字起こし $0.0048 + 話者分離 $0.0020
  realtimeFactor: 40,
  supportsBoost: true,
  boostNote: '用語辞書の boost を keywords パラメータとして送信します。',

  isConfigured: () => Boolean(config.keys.deepgram),

  async submit({ filePath, language, boost, signal, onRetry }) {
    const params = new URLSearchParams({
      model: this.model,
      diarize: 'true',
      punctuate: 'true',
      smart_format: 'true',
    });
    if (language && language !== 'auto') params.set('language', language);
    else params.set('detect_language', 'true');
    for (const term of (boost || []).slice(0, 100)) params.append('keywords', term);

    const json = await withRetry(
      async () => {
        const res = await fetch(`${BASE}?${params}`, {
          method: 'POST',
          headers: {
            Authorization: `Token ${config.keys.deepgram}`,
            'content-type': 'audio/ogg',
          },
          body: fs.createReadStream(filePath),
          duplex: 'half',
          signal,
        });
        if (!res.ok) throw httpError(res.status, await res.text(), 'Deepgram');
        return res.json();
      },
      { onRetry, label: 'Deepgram listen' },
    );

    return { externalJobId: json.metadata?.request_id || `dg_${Date.now()}`, result: toResult(json) };
  },

  async poll() {
    return { status: 'completed' };
  },
};

function toResult(json) {
  const alt = json.results?.channels?.[0]?.alternatives?.[0];
  const mapSpeaker = createSpeakerMapper();
  const words = (alt?.words || []).map((w) => ({
    text: w.punctuated_word || w.word,
    start: Number(w.start) || 0,
    end: Number(w.end) || 0,
    speakerId: mapSpeaker(w.speaker ?? 0),
    confidence: typeof w.confidence === 'number' ? w.confidence : null,
  }));
  if (!words.length) {
    return finalizeSegments([{ start: 0, end: 0, speakerId: 'A', text: alt?.transcript || '' }]);
  }
  return finalizeSegments(groupWords(words));
}
