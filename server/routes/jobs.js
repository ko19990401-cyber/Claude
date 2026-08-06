import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { config } from '../config.js';
import { getEngine } from '../asr/index.js';
import { clearHistory, getHistory, subscribe } from '../lib/events.js';
import { EXPORT_FORMATS, renderExport } from '../lib/exporters.js';
import { applyGlossary, revertGlossary } from '../lib/glossary.js';
import { cancelJob, isRunning, startJob } from '../lib/pipeline.js';
import { receiveUpload } from '../lib/upload.js';
import {
  audioFile, createJob, deleteJob, deleteSummary, getGlossary, getJob, getSegments,
  listJobs, listSummaries, newJobId, saveSegments, saveSummary, updateJob,
} from '../lib/store.js';
import { generateSummary } from '../llm/summarize.js';

export const jobsRoute = new Hono();

const notFound = () => Object.assign(new Error('ジョブが見つかりません'), { status: 404 });

async function loadJob(id) {
  const job = await getJob(id);
  if (!job) throw notFound();
  return job;
}

// --- POST /api/jobs : ファイルアップロード ---------------------------------
jobsRoute.post('/', async (c) => {
  const jobId = newJobId();
  const { fields, file } = await receiveUpload(c.env.incoming, { jobId });

  const provider = fields.provider || config.asrProvider;
  getEngine(provider); // 未知のプロバイダならここで弾く

  const job = {
    id: jobId,
    title: (fields.title || file.fileName.replace(/\.[^.]+$/, '')).slice(0, 120),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'queued',
    source: {
      fileName: file.fileName,
      durationSec: Number(fields.durationSec) || 0,
      originalBytes: file.bytes,
      processedBytes: 0,
      uploadPath: file.path,
      audioPath: null,
    },
    engine: {
      provider,
      model: getEngine(provider).model || getEngine(provider).id,
      language: fields.language || config.asrLanguage,
      diarization: true,
      speakerCount: Number(fields.speakerCount) || null,
      externalJobId: null,
      wasChunked: false,
    },
    speakers: [],
    glossaryId: fields.glossaryId || null,
    stats: null,
    error: null,
  };

  await createJob(job);
  startJob(jobId);
  return c.json(job, 201);
});

// --- GET /api/jobs : 一覧 --------------------------------------------------
jobsRoute.get('/', async (c) => c.json({ jobs: await listJobs() }));

// --- GET /api/jobs/:id : 詳細（セグメント含む）-----------------------------
jobsRoute.get('/:id', async (c) => {
  const job = await loadJob(c.req.param('id'));
  const [segments, summaries] = await Promise.all([getSegments(job.id), listSummaries(job.id)]);
  return c.json({ job, segments, summaries, running: isRunning(job.id) });
});

// --- PATCH /api/jobs/:id : タイトル変更 ------------------------------------
jobsRoute.patch('/:id', async (c) => {
  const { title } = await c.req.json();
  const job = await updateJob(c.req.param('id'), (j) => {
    if (typeof title === 'string' && title.trim()) j.title = title.trim().slice(0, 120);
  });
  return c.json({ job });
});

// --- GET /api/jobs/:id/events : SSE ---------------------------------------
jobsRoute.get('/:id/events', async (c) => {
  const id = c.req.param('id');
  await loadJob(id);

  return streamSSE(c, async (stream) => {
    let closed = false;
    stream.onAbort(() => { closed = true; });

    // 再接続時に経過を追えるよう、まず履歴を流す
    for (const event of getHistory(id)) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    }
    const job = await getJob(id);
    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify({ job, running: isRunning(id) }) });

    const queue = [];
    let notify = null;
    const unsubscribe = subscribe(id, (event) => {
      queue.push(event);
      notify?.();
    });

    try {
      while (!closed) {
        if (queue.length === 0) {
          await Promise.race([
            new Promise((resolve) => { notify = resolve; }),
            new Promise((resolve) => setTimeout(resolve, 15000)),
          ]);
          notify = null;
          if (queue.length === 0) {
            await stream.writeSSE({ event: 'ping', data: '{}' }); // 接続維持
            continue;
          }
        }
        const event = queue.shift();
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        if (event.type === 'completed' || event.type === 'failed') break;
      }
    } finally {
      unsubscribe();
    }
  });
});

// --- PATCH /api/jobs/:id/speakers : 話者名の更新（FR-04）--------------------
jobsRoute.patch('/:id/speakers', async (c) => {
  const body = await c.req.json();
  const updates = Array.isArray(body.speakers) ? body.speakers : [];
  const job = await updateJob(c.req.param('id'), (j) => {
    for (const update of updates) {
      const speaker = j.speakers.find((s) => s.id === update.id);
      if (speaker && typeof update.label === 'string' && update.label.trim()) {
        speaker.label = update.label.trim().slice(0, 60);
      }
    }
  });
  // セグメントは speakerId しか持たないので、リネームは1箇所で完結する（§8）
  return c.json({ speakers: job.speakers });
});

// --- PATCH /api/jobs/:id/segments/:segId : セグメント修正（FR-06）----------
jobsRoute.patch('/:id/segments/:segId', async (c) => {
  const id = c.req.param('id');
  const segId = c.req.param('segId');
  const body = await c.req.json();
  await loadJob(id);

  const segments = await getSegments(id);
  const segment = segments.find((s) => s.id === segId);
  if (!segment) throw Object.assign(new Error('セグメントが見つかりません'), { status: 404 });

  if (typeof body.text === 'string') {
    segment.text = body.text.replace(/\s+$/, '');
    segment.edited = true;
  }
  if (typeof body.speakerId === 'string' && /^[A-Z]|^S\d+$/.test(body.speakerId)) {
    segment.speakerId = body.speakerId;
  }
  await saveSegments(id, segments);

  await updateJob(id, (j) => {
    j.stats = { segmentCount: segments.length, charCount: segments.reduce((n, s) => n + s.text.length, 0) };
  });
  return c.json({ segment });
});

// --- GET /api/jobs/:id/audio : Range対応の音声配信 -------------------------
jobsRoute.get('/:id/audio', async (c) => {
  const id = c.req.param('id');
  await loadJob(id);
  const file = audioFile(id);
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) throw Object.assign(new Error('音声ファイルがありません'), { status: 404 });

  const range = c.req.header('range');
  const headers = {
    'content-type': 'audio/ogg',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=3600',
  };

  if (!range) {
    headers['content-length'] = String(stat.size);
    return new Response(Readable.toWeb(fs.createReadStream(file)), { status: 200, headers });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
  if (start >= stat.size || start > end) {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${stat.size}` } });
  }
  headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  headers['content-length'] = String(end - start + 1);
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), { status: 206, headers });
});

// --- POST /api/jobs/:id/summarize : 要約生成（SSEストリーム）---------------
jobsRoute.post('/:id/summarize', async (c) => {
  const id = c.req.param('id');
  const job = await loadJob(id);
  if (job.status !== 'completed') {
    throw Object.assign(new Error('文字起こしが完了していません'), { status: 409 });
  }
  const body = await c.req.json();
  const segments = await getSegments(id);
  if (!segments.length) throw Object.assign(new Error('文字起こしが空です'), { status: 409 });

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      const summary = await generateSummary({
        job,
        segments,
        speakers: job.speakers,
        presetId: body.presetId,
        customPrompt: body.customPrompt,
        model: body.model,
        effort: body.effort,
        forceRemap: Boolean(body.forceRemap),
        signal: controller.signal,
        onEvent: (event) => {
          // 生成過程をそのまま画面へ流す（体感速度に直結する）
          stream.writeSSE({ event: event.type.replace(':', '_'), data: JSON.stringify(event) });
        },
      });
      // 文字起こしとは別レコードとして保存する（FR-11）
      await saveSummary(id, summary);
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ summary }) });
    } catch (err) {
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ message: err.message }) });
    }
  });
});

jobsRoute.delete('/:id/summaries/:summaryId', async (c) => {
  await loadJob(c.req.param('id'));
  await deleteSummary(c.req.param('id'), c.req.param('summaryId'));
  return c.json({ ok: true });
});

// --- 用語辞書の適用・取り消し（FR-05）-------------------------------------
jobsRoute.post('/:id/glossary/apply', async (c) => {
  const id = c.req.param('id');
  const job = await loadJob(id);
  const body = await c.req.json().catch(() => ({}));
  const glossary = await getGlossary(body.glossaryId || job.glossaryId || 'glo_default');
  if (!glossary) throw Object.assign(new Error('辞書が見つかりません'), { status: 404 });

  const segments = await getSegments(id);
  const { segments: next, changes, count } = applyGlossary(segments, glossary);
  await saveSegments(id, next);
  await updateJob(id, (j) => {
    j.glossaryId = glossary.id;
    j.glossaryApplication = { glossaryId: glossary.id, appliedAt: new Date().toISOString(), count, changes };
  });
  return c.json({ count, segments: next });
});

jobsRoute.post('/:id/glossary/revert', async (c) => {
  const id = c.req.param('id');
  const job = await loadJob(id);
  const application = job.glossaryApplication;
  if (!application?.changes?.length) {
    throw Object.assign(new Error('取り消せる置換履歴がありません'), { status: 409 });
  }
  const segments = await getSegments(id);
  const { segments: next, reverted } = revertGlossary(segments, application.changes);
  await saveSegments(id, next);
  await updateJob(id, (j) => { j.glossaryApplication = null; });
  return c.json({ reverted, segments: next });
});

// --- GET /api/jobs/:id/export --------------------------------------------
jobsRoute.get('/:id/export', async (c) => {
  const id = c.req.param('id');
  const job = await loadJob(id);
  const format = c.req.query('format') || 'md';
  const spec = EXPORT_FORMATS[format];
  if (!spec) throw Object.assign(new Error(`未対応の形式です: ${format}`), { status: 400 });

  const include = c.req.query('include') || 'both'; // transcript | summary | both
  const includeTimestamps = c.req.query('timestamps') !== 'false';
  const segments = include === 'summary' ? [] : await getSegments(id);
  const all = await listSummaries(id);
  const requested = c.req.query('summaryId');
  const summaries = include === 'transcript'
    ? []
    : requested
      ? all.filter((s) => s.id === requested)
      : all;

  const text = renderExport(format, { job, segments, speakers: job.speakers, summaries, includeTimestamps });
  const safeTitle = job.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  return new Response(text, {
    headers: {
      'content-type': spec.mime,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${safeTitle}.${spec.ext}`)}`,
    },
  });
});

// --- 再試行・削除 ---------------------------------------------------------
jobsRoute.post('/:id/retry', async (c) => {
  const id = c.req.param('id');
  const job = await loadJob(id);
  if (isRunning(id)) throw Object.assign(new Error('すでに処理中です'), { status: 409 });
  const hasAudio = await fsp.stat(audioFile(id)).then(() => true).catch(() => false);
  const hasUpload = job.source.uploadPath
    ? await fsp.stat(job.source.uploadPath).then(() => true).catch(() => false)
    : false;
  if (!hasAudio && !hasUpload) {
    throw Object.assign(new Error('音声ファイルが残っていないため再試行できません'), { status: 409 });
  }
  await updateJob(id, (j) => {
    j.status = 'queued';
    j.error = null;
  });
  startJob(id);
  return c.json({ ok: true });
});

jobsRoute.post('/:id/cancel', async (c) => {
  cancelJob(c.req.param('id'));
  return c.json({ ok: true });
});

jobsRoute.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await loadJob(id);
  cancelJob(id);
  await deleteJob(id);
  clearHistory(id);
  return c.json({ ok: true });
});
