import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from '../config.js';

/**
 * ジョブの永続化層。
 *
 * data/
 *   jobs/<jobId>/job.json           … メタ情報・話者・エンジン・状態
 *   jobs/<jobId>/segments.json      … セグメント（文字起こし本体）
 *   jobs/<jobId>/intermediate.json  … 階層要約の中間要約
 *   jobs/<jobId>/summaries/<id>.json… 要約（1件1ファイル）
 *   audio/<jobId>.ogg               … 前処理済み音声
 *   glossaries/<id>.json            … 用語辞書
 *
 * segments と summaries を別ファイルに分けているのは仕様書 §8 の設計方針
 * （要約の作り直しが文字起こしに影響しない／要約失敗時も文字起こしは残る）に従うため。
 */

export async function ensureDirs() {
  for (const dir of Object.values(paths)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

export function newJobId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(
    date.getHours(),
  )}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `job_${stamp}_${crypto.randomBytes(2).toString('hex')}`;
}

export const jobDir = (jobId) => path.join(paths.jobs, jobId);
const jobFile = (jobId) => path.join(jobDir(jobId), 'job.json');
const segmentsFile = (jobId) => path.join(jobDir(jobId), 'segments.json');
const intermediateFile = (jobId) => path.join(jobDir(jobId), 'intermediate.json');
const summaryDir = (jobId) => path.join(jobDir(jobId), 'summaries');
export const audioFile = (jobId) => path.join(paths.audio, `${jobId}.ogg`);

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

/** 書き込み中の電源断で壊れたJSONが残らないよう、一時ファイル経由で置換する。 */
async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// 同一ジョブへの並行書き込みを直列化する（SSE進捗更新とAPI更新が競合しうるため）
const locks = new Map();
export function withJobLock(jobId, fn) {
  const prev = locks.get(jobId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    jobId,
    next.catch(() => {}).finally(() => {
      if (locks.get(jobId) === next) locks.delete(jobId);
    }),
  );
  return next;
}

export async function createJob(job) {
  await writeJson(jobFile(job.id), job);
  await writeJson(segmentsFile(job.id), []);
  return job;
}

export async function getJob(jobId) {
  if (!/^job_[\w-]+$/.test(jobId)) return null;
  return readJson(jobFile(jobId));
}

export async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  await writeJson(jobFile(job.id), job);
  return job;
}

/** 読み込み→変更→保存 をロック下で行う。patch は job を受け取って書き換える関数。 */
export function updateJob(jobId, patch) {
  return withJobLock(jobId, async () => {
    const job = await getJob(jobId);
    if (!job) throw Object.assign(new Error('job not found'), { status: 404 });
    const result = await patch(job);
    await saveJob(job);
    return result === undefined ? job : result;
  });
}

export async function listJobs() {
  let entries = [];
  try {
    entries = await fs.readdir(paths.jobs, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const jobs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const job = await readJson(path.join(paths.jobs, entry.name, 'job.json'));
    if (job) {
      job.summaryCount = (await listSummaries(job.id)).length;
      jobs.push(job);
    }
  }
  jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return jobs;
}

export const getSegments = (jobId) => readJson(segmentsFile(jobId), []);
export const saveSegments = (jobId, segments) => writeJson(segmentsFile(jobId), segments);

export const getIntermediate = (jobId) => readJson(intermediateFile(jobId), null);
export const saveIntermediate = (jobId, data) => writeJson(intermediateFile(jobId), data);

export async function listSummaries(jobId) {
  let files = [];
  try {
    files = await fs.readdir(summaryDir(jobId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    return [];
  }
  const items = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const s = await readJson(path.join(summaryDir(jobId), f));
    if (s) items.push(s);
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

export const getSummary = (jobId, summaryId) =>
  /^sum_[\w-]+$/.test(summaryId) ? readJson(path.join(summaryDir(jobId), `${summaryId}.json`)) : null;

export const saveSummary = (jobId, summary) =>
  writeJson(path.join(summaryDir(jobId), `${summary.id}.json`), summary);

export async function deleteSummary(jobId, summaryId) {
  if (!/^sum_[\w-]+$/.test(summaryId)) return;
  await fs.rm(path.join(summaryDir(jobId), `${summaryId}.json`), { force: true });
}

/** ジョブと音声ファイルを物理削除する（FR-10）。 */
export async function deleteJob(jobId) {
  const job = await getJob(jobId);
  await fs.rm(jobDir(jobId), { recursive: true, force: true });
  await fs.rm(audioFile(jobId), { force: true });
  if (job?.source?.uploadPath) await fs.rm(job.source.uploadPath, { force: true });
  return job;
}

// --- 用語辞書 -------------------------------------------------------------

const DEFAULT_GLOSSARY_ID = 'glo_default';

const defaultGlossary = () => ({
  id: DEFAULT_GLOSSARY_ID,
  name: '既定の辞書',
  boost: [
    'LGWAN', '自治体情報システム標準化', 'ガバメントクラウド',
    'BPR', 'DX推進', '上川管内', '情報防災係', '復命書',
  ],
  replace: [
    { from: 'エルゴワン', to: 'LGWAN', regex: false },
    { from: 'ガバメントクラウト', to: 'ガバメントクラウド', regex: false },
    { from: 'ビーピーアール', to: 'BPR', regex: false },
  ],
  updatedAt: new Date().toISOString(),
});

const glossaryFile = (id) => path.join(paths.glossaries, `${id}.json`);

export async function getGlossary(id = DEFAULT_GLOSSARY_ID) {
  if (!/^glo_[\w-]+$/.test(id)) return null;
  const existing = await readJson(glossaryFile(id));
  if (existing) return existing;
  if (id === DEFAULT_GLOSSARY_ID) {
    const g = defaultGlossary();
    await writeJson(glossaryFile(id), g);
    return g;
  }
  return null;
}

export async function saveGlossary(glossary) {
  glossary.updatedAt = new Date().toISOString();
  await writeJson(glossaryFile(glossary.id), glossary);
  return glossary;
}

export async function listGlossaries() {
  await getGlossary(DEFAULT_GLOSSARY_ID); // 既定辞書を必ず用意する
  const files = await fs.readdir(paths.glossaries).catch(() => []);
  const items = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const g = await readJson(path.join(paths.glossaries, f));
    if (g) items.push(g);
  }
  return items;
}

export { DEFAULT_GLOSSARY_ID };
