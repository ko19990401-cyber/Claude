import fs from 'node:fs/promises';
import path from 'node:path';
import { config, paths } from '../config.js';
import { getEngine } from '../asr/index.js';
import { detectSilences, preprocess, probeDuration, sliceAudio } from './ffmpeg.js';
import { mergeChunkResults, planChunks } from './chunker.js';
import { applyGlossary } from './glossary.js';
import { emitJobEvent } from './events.js';
import { log } from './logger.js';
import {
  audioFile, getGlossary, getJob, listJobs, saveSegments, updateJob,
} from './store.js';

const running = new Map(); // jobId -> AbortController

export const isRunning = (jobId) => running.has(jobId);

/** ジョブ処理を開始する（呼び出し側は待たない）。 */
export function startJob(jobId) {
  if (running.has(jobId)) return;
  const controller = new AbortController();
  running.set(jobId, controller);
  processJob(jobId, controller.signal)
    .catch(async (err) => {
      log.error(`job ${jobId} failed:`, err.message);
      await updateJob(jobId, (job) => {
        job.status = 'failed';
        job.error = { message: err.message, at: new Date().toISOString(), retryable: true };
      }).catch(() => {});
      emitJobEvent(jobId, 'failed', { message: err.message });
    })
    .finally(() => running.delete(jobId));
}

export function cancelJob(jobId) {
  running.get(jobId)?.abort();
}

async function setStatus(jobId, status, extra = {}) {
  await updateJob(jobId, (job) => {
    job.status = status;
    Object.assign(job, extra);
  });
  emitJobEvent(jobId, 'status', { status, ...extra });
}

async function processJob(jobId, signal) {
  const job = await getJob(jobId);
  if (!job) throw new Error('ジョブが見つかりません');

  // --- 1. 前処理（FR-02）------------------------------------------------
  const target = audioFile(jobId);
  const alreadyPreprocessed = await fs.stat(target).then((s) => s.size > 0).catch(() => false);

  if (!alreadyPreprocessed) {
    await setStatus(jobId, 'preprocessing');
    emitJobEvent(jobId, 'phase', { phase: 'preprocessing', label: '音声を変換しています' });

    const durationSec = job.source.durationSec || (await probeDuration(job.source.uploadPath));
    const { bytes } = await preprocess(job.source.uploadPath, target, {
      durationSec,
      onProgress: ({ processedSec, ratio }) =>
        emitJobEvent(jobId, 'progress', { phase: 'preprocessing', processedSec, ratio }),
    });

    await updateJob(jobId, (j) => {
      j.source.durationSec = Math.round(durationSec);
      j.source.processedBytes = bytes;
      j.source.audioPath = path.relative(config.dataDir, target);
    });
    // 変換済みなので原本は不要。ディスクを食わせない。
    await fs.rm(job.source.uploadPath, { force: true }).catch(() => {});
    await updateJob(jobId, (j) => { j.source.uploadPath = null; });
  }

  const current = await getJob(jobId);
  const engine = getEngine(current.engine.provider);
  if (!engine.isConfigured()) {
    throw Object.assign(new Error(`${engine.label} のAPIキーが設定されていません。.env を確認してください。`), { fatal: true });
  }

  const glossary = current.glossaryId ? await getGlossary(current.glossaryId) : null;
  const boost = engine.supportsBoost ? glossary?.boost || [] : [];

  // --- 2. 文字起こし（FR-03）-------------------------------------------
  await setStatus(jobId, 'uploading');
  emitJobEvent(jobId, 'phase', { phase: 'uploading', label: '音声を送信しています' });

  const stat = await fs.stat(target);
  const needsChunking = stat.size > engine.maxUploadBytes;

  let result;
  if (!needsChunking) {
    result = await transcribeWhole({ jobId, engine, file: target, job: current, boost, signal });
  } else {
    result = await transcribeChunked({ jobId, engine, file: target, job: current, boost, signal, totalBytes: stat.size });
  }

  // --- 3. 用語辞書の2段目（FR-05）--------------------------------------
  let segments = result.segments;
  let glossaryResult = { changes: [], count: 0 };
  if (glossary) {
    glossaryResult = applyGlossary(segments, glossary);
    segments = glossaryResult.segments;
  }

  await saveSegments(jobId, segments);
  await updateJob(jobId, (j) => {
    j.status = 'completed';
    j.completedAt = new Date().toISOString();
    j.speakers = recountSpeakers(segments, result.speakers);
    j.engine.wasChunked = Boolean(result.wasChunked);
    j.engine.externalJobId = result.externalJobId || j.engine.externalJobId;
    j.stats = {
      segmentCount: segments.length,
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
    };
    j.glossaryApplication = glossary
      ? {
          glossaryId: glossary.id,
          appliedAt: new Date().toISOString(),
          count: glossaryResult.count,
          changes: glossaryResult.changes,
        }
      : null;
    j.error = null;
  });

  emitJobEvent(jobId, 'completed', {
    segmentCount: segments.length,
    replaced: glossaryResult.count,
    wasChunked: Boolean(result.wasChunked),
  });
  log.ok(`job ${jobId} completed: ${segments.length} segments`);
}

async function transcribeWhole({ jobId, engine, file, job, boost, signal }) {
  const submitted = await engine.submit({
    filePath: file,
    language: job.engine.language,
    speakerCount: job.engine.speakerCount || undefined,
    boost,
    signal,
    onRetry: ({ attempt, retries, waitMs, error }) =>
      emitJobEvent(jobId, 'retry', { attempt, retries, waitMs, message: error.message }),
  });

  await updateJob(jobId, (j) => { j.engine.externalJobId = submitted.externalJobId; });
  await setStatus(jobId, 'transcribing');
  emitJobEvent(jobId, 'phase', { phase: 'transcribing', label: '文字起こしを実行しています' });

  if (submitted.result) return { ...submitted.result, externalJobId: submitted.externalJobId };

  const result = await pollUntilDone(jobId, engine, submitted.externalJobId, signal);
  return { ...result, externalJobId: submitted.externalJobId };
}

/** API上限を超えた場合のみ実行される分割モード（FR-03 の 2・3）。 */
async function transcribeChunked({ jobId, engine, file, job, boost, signal, totalBytes }) {
  emitJobEvent(jobId, 'warning', {
    code: 'chunked',
    message: 'ファイルがAPI上限を超えるため、無音区間で分割して処理します。話者ラベルの対応付けに誤りが生じる可能性があります。',
  });

  const silences = await detectSilences(file);
  const chunks = planChunks({
    durationSec: job.source.durationSec,
    totalBytes,
    maxBytes: engine.maxUploadBytes,
    silences,
  });
  emitJobEvent(jobId, 'chunks', { count: chunks.length });

  await setStatus(jobId, 'transcribing');
  const chunkResults = [];
  for (const chunk of chunks) {
    const partPath = path.join(paths.tmp, `${jobId}_part${chunk.index}.ogg`);
    await sliceAudio(file, partPath, chunk.start, chunk.end);
    try {
      const submitted = await engine.submit({
        filePath: partPath,
        language: job.engine.language,
        speakerCount: job.engine.speakerCount || undefined,
        boost,
        signal,
        onRetry: ({ attempt, retries, waitMs, error }) =>
          emitJobEvent(jobId, 'retry', { attempt, retries, waitMs, message: error.message }),
      });
      const result = submitted.result || (await pollUntilDone(jobId, engine, submitted.externalJobId, signal));
      chunkResults.push({ ...chunk, result });
      emitJobEvent(jobId, 'progress', {
        phase: 'transcribing',
        ratio: (chunk.index + 1) / chunks.length,
        detail: `${chunk.index + 1}/${chunks.length} 完了`,
      });
    } finally {
      await fs.rm(partPath, { force: true }).catch(() => {});
    }
  }

  const merged = mergeChunkResults(chunkResults);
  const renumbered = merged.map((seg, i) => ({ ...seg, id: `seg_${String(i + 1).padStart(4, '0')}` }));
  return { segments: renumbered, speakers: [], wasChunked: true };
}

async function pollUntilDone(jobId, engine, externalJobId, signal, { intervalMs = 5000 } = {}) {
  let waited = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('処理が中断されました');
    const status = await engine.poll(externalJobId, { signal });
    if (status.status === 'completed') return status.result;
    if (status.status === 'failed') throw new Error(status.error || '文字起こしに失敗しました');
    await new Promise((r) => setTimeout(r, intervalMs));
    waited += intervalMs;
    emitJobEvent(jobId, 'progress', {
      phase: 'transcribing',
      waitedSec: Math.round(waited / 1000),
      detail: status.detail,
    });
  }
}

function recountSpeakers(segments, fromEngine = []) {
  const map = new Map();
  for (const seg of segments) {
    const agg = map.get(seg.speakerId) || {
      id: seg.speakerId,
      label: fromEngine.find((s) => s.id === seg.speakerId)?.label || `話者${seg.speakerId}`,
      utteranceCount: 0,
      totalSec: 0,
    };
    agg.utteranceCount += 1;
    agg.totalSec += Math.max(0, seg.end - seg.start);
    map.set(seg.speakerId, agg);
  }
  return [...map.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ ...s, totalSec: Number(s.totalSec.toFixed(1)) }));
}

/**
 * 起動時の復旧（FR-11）。
 * 非同期APIのジョブは externalJobId からポーリングを再開できる。
 * 同期APIのジョブはプロセス終了で失われるため、再試行可能な失敗として提示する。
 */
export async function resumeJobs() {
  const jobs = await listJobs();
  const pending = jobs.filter((j) => ['queued', 'preprocessing', 'uploading', 'transcribing'].includes(j.status));
  for (const job of pending) {
    const engine = getEngine(job.engine.provider);
    const resumable = engine.mode === 'async' && job.engine.externalJobId && job.status === 'transcribing';
    if (resumable) {
      log.info(`resuming job ${job.id} (${engine.label} ${job.engine.externalJobId})`);
      startResume(job.id, engine, job.engine.externalJobId);
    } else if (job.status !== 'queued') {
      await updateJob(job.id, (j) => {
        j.status = 'failed';
        j.error = {
          message: 'サーバ再起動により処理が中断されました。アップロード済みの音声は保持しています。再試行してください。',
          at: new Date().toISOString(),
          retryable: true,
        };
      }).catch(() => {});
    } else {
      startJob(job.id);
    }
  }
  return pending.length;
}

function startResume(jobId, engine, externalJobId) {
  if (running.has(jobId)) return;
  const controller = new AbortController();
  running.set(jobId, controller);
  (async () => {
    const result = await pollUntilDone(jobId, engine, externalJobId, controller.signal);
    const job = await getJob(jobId);
    const glossary = job.glossaryId ? await getGlossary(job.glossaryId) : null;
    let segments = result.segments;
    let applied = { changes: [], count: 0 };
    if (glossary) {
      applied = applyGlossary(segments, glossary);
      segments = applied.segments;
    }
    await saveSegments(jobId, segments);
    await updateJob(jobId, (j) => {
      j.status = 'completed';
      j.completedAt = new Date().toISOString();
      j.speakers = recountSpeakers(segments, result.speakers);
      j.stats = { segmentCount: segments.length, charCount: segments.reduce((n, s) => n + s.text.length, 0) };
      j.error = null;
    });
    emitJobEvent(jobId, 'completed', { segmentCount: segments.length, resumed: true });
  })()
    .catch(async (err) => {
      await updateJob(jobId, (j) => {
        j.status = 'failed';
        j.error = { message: err.message, at: new Date().toISOString(), retryable: true };
      }).catch(() => {});
      emitJobEvent(jobId, 'failed', { message: err.message });
    })
    .finally(() => running.delete(jobId));
}
