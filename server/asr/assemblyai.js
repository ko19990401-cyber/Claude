import fs from 'node:fs';
import { config } from '../config.js';
import { createSpeakerMapper, finalizeSegments, httpError, withRetry } from './util.js';

const BASE = 'https://api.assemblyai.com/v2';

/**
 * AssemblyAI Universal（対抗馬）。
 * 真の非同期バッチAPIなので、ブラウザやサーバを再起動しても
 * transcript id からポーリングを再開できる（FR-11）。
 */
export const assemblyai = {
  id: 'assemblyai',
  label: 'AssemblyAI Universal',
  mode: 'async',
  maxUploadBytes: 2 * 1024 * 1024 * 1024,
  usdPerMinute: 0.0037,
  realtimeFactor: 25,
  supportsBoost: true,
  boostNote: '用語辞書の boost を word_boost（最大1000語）として送信します。',

  isConfigured: () => Boolean(config.keys.assemblyai),

  async submit({ filePath, language, speakerCount, boost, signal, onRetry }) {
    const uploadUrl = await withRetry(
      async () => {
        const res = await fetch(`${BASE}/upload`, {
          method: 'POST',
          headers: {
            authorization: config.keys.assemblyai,
            'content-type': 'application/octet-stream',
          },
          body: fs.createReadStream(filePath),
          duplex: 'half',
          signal,
        });
        if (!res.ok) throw httpError(res.status, await res.text(), 'AssemblyAI(upload)');
        return (await res.json()).upload_url;
      },
      { onRetry, label: 'AssemblyAI upload' },
    );

    const body = {
      audio_url: uploadUrl,
      speaker_labels: true,
      punctuate: true,
      format_text: true,
    };
    if (language && language !== 'auto') body.language_code = language;
    else body.language_detection = true;
    if (speakerCount) body.speakers_expected = speakerCount;
    if (boost?.length) {
      body.word_boost = boost.slice(0, 1000);
      body.boost_param = 'high';
    }

    const created = await withRetry(
      async () => {
        const res = await fetch(`${BASE}/transcript`, {
          method: 'POST',
          headers: { authorization: config.keys.assemblyai, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal,
        });
        if (res.ok) return res.json();
        const text = await res.text();
        // word_boost が言語未対応で弾かれた場合は外して再送する
        if (res.status === 400 && /word_boost/i.test(text) && body.word_boost) {
          delete body.word_boost;
          delete body.boost_param;
          const retry = await fetch(`${BASE}/transcript`, {
            method: 'POST',
            headers: { authorization: config.keys.assemblyai, 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });
          if (!retry.ok) throw httpError(retry.status, await retry.text(), 'AssemblyAI');
          return retry.json();
        }
        throw httpError(res.status, text, 'AssemblyAI');
      },
      { onRetry, label: 'AssemblyAI transcript' },
    );

    return { externalJobId: created.id };
  },

  async poll(externalJobId, { signal } = {}) {
    const json = await withRetry(
      async () => {
        const res = await fetch(`${BASE}/transcript/${externalJobId}`, {
          headers: { authorization: config.keys.assemblyai },
          signal,
        });
        if (!res.ok) throw httpError(res.status, await res.text(), 'AssemblyAI(poll)');
        return res.json();
      },
      { retries: 2, label: 'AssemblyAI poll' },
    );

    if (json.status === 'error') return { status: 'failed', error: json.error };
    if (json.status !== 'completed') return { status: 'processing', detail: json.status };
    return { status: 'completed', result: toResult(json) };
  },
};

function toResult(json) {
  const mapSpeaker = createSpeakerMapper();
  const utterances = json.utterances || [];
  if (utterances.length) {
    return finalizeSegments(
      utterances.map((u) => ({
        start: (u.start ?? 0) / 1000,
        end: (u.end ?? 0) / 1000,
        speakerId: mapSpeaker(u.speaker),
        text: u.text || '',
        confidence: typeof u.confidence === 'number' ? u.confidence : null,
      })),
    );
  }
  return finalizeSegments([{ start: 0, end: 0, speakerId: 'A', text: json.text || '', confidence: json.confidence ?? null }]);
}
