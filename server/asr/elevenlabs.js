import { config } from '../config.js';
import { createSpeakerMapper, fileBlob, finalizeSegments, groupWords, httpError, withRetry } from './util.js';

const ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * ElevenLabs Scribe（第一候補）。
 * 話者分離が基本料金に込みで、非英語の評判が良い。
 * 同期APIなので、長時間音声では1リクエストが数分かかる点に注意。
 */
export const elevenlabs = {
  id: 'elevenlabs',
  label: 'ElevenLabs Scribe',
  mode: 'sync',
  model: 'scribe_v1',
  // 公称上限は 1GB / 4.5時間。前処理後の24kbps Opusなら10時間でも約110MB。
  maxUploadBytes: 900 * 1024 * 1024,
  usdPerMinute: 0.004,
  realtimeFactor: 15, // 音声長のおよそ1/15の時間で完了する（実測で調整すること）
  supportsBoost: false,
  boostNote: 'Scribe はカスタム語彙に非対応のため、辞書は文字起こし後の置換（2段目）のみ適用されます。',

  isConfigured: () => Boolean(config.keys.elevenlabs),

  async submit({ filePath, language, speakerCount, signal, onRetry }) {
    const form = new FormData();
    form.append('file', await fileBlob(filePath, 'audio/ogg'), 'audio.ogg');
    form.append('model_id', this.model);
    form.append('diarize', 'true');
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'false');
    if (language && language !== 'auto') form.append('language_code', language);
    if (speakerCount) form.append('num_speakers', String(speakerCount));

    const json = await withRetry(
      async () => {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'xi-api-key': config.keys.elevenlabs },
          body: form,
          signal,
        });
        if (!res.ok) throw httpError(res.status, await res.text(), 'ElevenLabs');
        return res.json();
      },
      { onRetry, label: 'ElevenLabs speech-to-text' },
    );

    return { externalJobId: `el_${Date.now()}`, result: toResult(json) };
  },

  async poll() {
    // 同期APIのため submit の時点で完了している
    return { status: 'completed' };
  },
};

function toResult(json) {
  const mapSpeaker = createSpeakerMapper();
  const words = (json.words || [])
    .filter((w) => w.type !== 'audio_event' && (w.text ?? '').trim() !== '')
    .map((w) => ({
      text: w.text,
      start: Number(w.start) || 0,
      end: Number(w.end) || Number(w.start) || 0,
      speakerId: mapSpeaker(w.speaker_id ?? 'speaker_0'),
      confidence: typeof w.logprob === 'number' ? Math.min(1, Math.exp(w.logprob)) : null,
    }));

  if (!words.length && json.text) {
    // 単語タイムスタンプが返らなかった場合の保険
    return finalizeSegments([{ start: 0, end: 0, speakerId: 'A', text: json.text }]);
  }
  return finalizeSegments(groupWords(words));
}
