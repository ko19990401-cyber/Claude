/**
 * 文字起こしパイプラインの統合テスト。
 * アップロード → ffmpeg前処理 → ASR（モック）→ 用語辞書 → 編集 → 出力 → 削除 まで通す。
 * 実行: DATA_DIR=./.test-data ASR_PROVIDER=mock PORT=8799 node test/pipeline.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installMockEngine } from './mock-engine.mjs';
import {
  collectSse, createChecker, makeAudio, waitForJob,
} from './helpers.mjs';

const BASE = `http://localhost:${process.env.PORT}`;
const DATA = path.resolve(process.env.DATA_DIR);

installMockEngine();
fs.rmSync(DATA, { recursive: true, force: true });
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 1200));

const { check, finish } = createChecker('文字起こしパイプライン');

// --- アップロード ---------------------------------------------------------
const wav = makeAudio('/tmp/koe-pipeline.wav', { durationSec: 20 });
const wavBytes = fs.statSync(wav).size;

const form = new FormData();
form.append('title', '上川管内電算協議会 定例会');
form.append('durationSec', '20');
form.append('glossaryId', 'glo_default');
form.append('language', 'ja');
form.append('file', await fs.openAsBlob(wav), 'meeting.wav');

const created = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: form })).json();
check('POST /api/jobs でジョブを作成', Boolean(created.id), created.id);

const ssePromise = collectSse(`${BASE}/api/jobs/${created.id}/events`);
let job = await waitForJob(BASE, created.id);
const events = await ssePromise;

check('ジョブが完了する', job.job.status === 'completed', job.job.error?.message || '');
check('SSEで進捗を配信する',
  events.some((e) => e.type === 'phase') && events.some((e) => e.type === 'completed'),
  [...new Set(events.map((e) => e.type))].join(','));

// --- 前処理（FR-02）-------------------------------------------------------
const audioPath = path.join(DATA, 'audio', `${created.id}.ogg`);
const oggBytes = fs.existsSync(audioPath) ? fs.statSync(audioPath).size : 0;
check('ffmpegで前処理する', oggBytes > 0 && oggBytes < wavBytes,
  `${Math.round(wavBytes / 1024)}KB → ${Math.round(oggBytes / 1024)}KB（約${Math.round(wavBytes / oggBytes)}分の1）`);

const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,channels',
  '-of', 'default=nw=1', audioPath]).toString().replace(/\n/g, ' ').trim();
check('モノラル / Opus へ正規化する', /opus/.test(probe) && /channels=1/.test(probe), probe);
check('変換後は元ファイルを残さない', job.job.source.uploadPath === null);

// --- 用語辞書の2段目（FR-05）----------------------------------------------
const texts = job.segments.map((s) => s.text).join(' ');
check('置換辞書：エルゴワン → LGWAN', texts.includes('LGWAN') && !texts.includes('エルゴワン'));
check('置換辞書：ガバメントクラウト → ガバメントクラウド', texts.includes('ガバメントクラウド'));
check('置換辞書：ビーピーアール → BPR', texts.includes('BPR'));
check('取り消し用に置換履歴を残す', job.job.glossaryApplication?.changes?.length === 3,
  `${job.job.glossaryApplication?.count}箇所`);

// --- 話者（FR-04）---------------------------------------------------------
check('話者を分離する', job.job.speakers.length === 2,
  job.job.speakers.map((s) => `${s.label}:${s.utteranceCount}回`).join(' '));
check('話者ごとの発言時間を集計する', job.job.speakers.every((s) => s.totalSec > 0));

await fetch(`${BASE}/api/jobs/${created.id}/speakers`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ speakers: [{ id: 'A', label: '議長（総務課長）' }] }),
});
job = await (await fetch(`${BASE}/api/jobs/${created.id}`)).json();
check('話者名を更新する', job.job.speakers[0].label === '議長（総務課長）');
check('セグメントはspeakerIdのみ持つ（リネームは1箇所で済む）',
  job.segments.every((s) => !('speakerLabel' in s) && typeof s.speakerId === 'string'));

// --- セグメント編集（FR-06）-----------------------------------------------
const segId = job.segments[1].id;
await fetch(`${BASE}/api/jobs/${created.id}/segments/${segId}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '移行スケジュールを確認したいのですが。' }),
});
job = await (await fetch(`${BASE}/api/jobs/${created.id}`)).json();
check('セグメントを編集し編集済みフラグを立てる',
  job.segments[1].edited === true && job.segments[1].text.startsWith('移行'));

// --- 置換の取り消し -------------------------------------------------------
const reverted = await (await fetch(`${BASE}/api/jobs/${created.id}/glossary/revert`, { method: 'POST' })).json();
check('置換をワンクリックで取り消す',
  reverted.reverted === 3 && reverted.segments.some((s) => s.text.includes('エルゴワン')),
  `${reverted.reverted}件`);
await fetch(`${BASE}/api/jobs/${created.id}/glossary/apply`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
});

// --- エクスポート（FR-09）-------------------------------------------------
for (const [format, needle] of [['md', '# '], ['txt', '['], ['srt', '-->'], ['vtt', 'WEBVTT']]) {
  const res = await fetch(`${BASE}/api/jobs/${created.id}/export?format=${format}`);
  const text = await res.text();
  check(`エクスポート .${format}`, res.ok && text.includes(needle), `${text.length}字`);
}
const noTs = await (await fetch(`${BASE}/api/jobs/${created.id}/export?format=txt&timestamps=false`)).text();
check('タイムスタンプ無しのテキスト出力', !/\[\d\d:\d\d:\d\d\]/.test(noTs));

// --- 音声配信（Rangeリクエスト）-------------------------------------------
const range = await fetch(`${BASE}/api/jobs/${created.id}/audio`, { headers: { range: 'bytes=0-99' } });
check('音声をRangeリクエストで配信する（シークに必要）',
  range.status === 206 && range.headers.get('content-length') === '100',
  range.headers.get('content-range'));

// --- コスト・時間の試算（FR-01 / 非機能要件）------------------------------
const est = await (await fetch(`${BASE}/api/estimate`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ durationSec: 3600, provider: 'elevenlabs' }),
})).json();
check('1時間あたりのコスト試算が80円以内', est.cost.totalJpy <= 80, `${est.cost.totalJpy}円`);
check('1時間の処理時間見込みが6分以内', est.time.totalSec <= 360, `約${Math.round(est.time.totalSec / 60)}分`);

// --- 要約が失敗しても文字起こしは失われない（FR-11）------------------------
const summarize = await fetch(`${BASE}/api/jobs/${created.id}/summarize`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ presetId: 'minutes' }),
});
const summarizeBody = await summarize.text();
check('APIキー未設定ならエラーイベントを返す',
  summarizeBody.includes('event: error') && summarizeBody.includes('ANTHROPIC_API_KEY'));
const after = await (await fetch(`${BASE}/api/jobs/${created.id}`)).json();
check('要約が失敗しても文字起こしは残る', after.segments.length === 3);

// --- 物理削除（FR-10）-----------------------------------------------------
await fetch(`${BASE}/api/jobs/${created.id}`, { method: 'DELETE' });
check('ジョブと音声を物理削除する',
  !fs.existsSync(path.join(DATA, 'jobs', created.id)) && !fs.existsSync(audioPath));

process.exit(finish() ? 1 : 0);
