/**
 * FR-03 分割フォールバックのテスト。
 * 無音検出 → 分割計画 → 切り出し → 重複除去 → 話者ラベル対応付け、
 * さらにパイプライン全体を分割モードで通す。
 * 実行: DATA_DIR=./.test-data-chunk ASR_PROVIDER=mock PORT=8797 node test/chunking.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { detectSilences, sliceAudio } from '../server/lib/ffmpeg.js';
import { mergeChunkResults, planChunks } from '../server/lib/chunker.js';
import { installMockEngine } from './mock-engine.mjs';
import {
  collectSse, createChecker, makeAudio, probeDuration, waitForJob,
} from './helpers.mjs';

const { check, finish } = createChecker('分割フォールバック（FR-03）');

// --- 無音検出 -------------------------------------------------------------
makeAudio('/tmp/koe-chunk.ogg', { durationSec: 60, silences: [[19, 21], [39, 41]], stereo: false, encode: true });
const silences = await detectSilences('/tmp/koe-chunk.ogg');
check('silencedetect で無音区間を検出する', silences.length === 2,
  silences.map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}s`).join(' / '));

// --- 分割計画 -------------------------------------------------------------
const totalBytes = 300_000;
const maxBytes = 175_000;
const plan = planChunks({ durationSec: 60, totalBytes, maxBytes, silences, overlapSec: 5 });
const bytesPerSec = totalBytes / 60;

check('上限超過で複数チャンクに分ける', plan.length === 3, `${plan.length}分割`);
check('各チャンクがのりしろ込みで上限に収まる',
  plan.every((c) => (c.end - c.start) * bytesPerSec <= maxBytes),
  plan.map((c) => `${Math.round(((c.end - c.start) * bytesPerSec) / 1024)}KB`).join(' / '));
check('境界が無音区間の中央に寄る',
  Math.abs(plan[0].coreEnd - 20) < 1.5 && Math.abs(plan[1].coreEnd - 40) < 1.5,
  plan.map((c) => `${c.coreStart.toFixed(1)}-${c.coreEnd.toFixed(1)}`).join(' / '));
check('前後にのりしろを持たせる',
  plan[1].start < plan[1].coreStart && plan[1].end > plan[1].coreEnd,
  `切出 ${plan[1].start.toFixed(1)}-${plan[1].end.toFixed(1)} / 採用 ${plan[1].coreStart.toFixed(1)}-${plan[1].coreEnd.toFixed(1)}`);
check('先頭と末尾の外側にはのりしろを付けない',
  plan[0].overlapBefore === 0 && plan[plan.length - 1].overlapAfter === 0);
check('上限内なら分割しない（原則こちら）',
  planChunks({ durationSec: 3600, totalBytes: 10_000_000, maxBytes: 900_000_000, silences: [] }).length === 1);

// --- 実際の切り出し -------------------------------------------------------
const { bytes } = await sliceAudio('/tmp/koe-chunk.ogg', '/tmp/koe-part.ogg', plan[1].start, plan[1].end);
check('ffmpegで該当区間を切り出せる',
  bytes > 0 && Math.abs(probeDuration('/tmp/koe-part.ogg') - (plan[1].end - plan[1].start)) < 1,
  `${probeDuration('/tmp/koe-part.ogg').toFixed(1)}秒`);
fs.rmSync('/tmp/koe-part.ogg', { force: true });

// --- 結合：重複除去と話者ラベルの対応付け ----------------------------------
// ASRはチャンクごとにラベルを振り直すので、チャンク2の「話者B」がチャンク1の「話者A」に
// なりうる。この取り違えを直せることを確認する。
const merged = mergeChunkResults([
  {
    ...plan[0],
    result: {
      segments: [
        { id: 's1', start: 0, end: 5, speakerId: 'A', text: '本日の議題は標準化です。' },
        { id: 's2', start: 6, end: 12, speakerId: 'B', text: '移行時期を確認させてください。' },
        { id: 's3', start: 16, end: 19, speakerId: 'A', text: '来年3月末を予定しています。' },
      ],
    },
  },
  {
    ...plan[1],
    result: {
      segments: [
        { id: 't1', start: 1, end: 4, speakerId: 'B', text: '来年3月末を予定しています。' },
        { id: 't2', start: 6, end: 12, speakerId: 'A', text: '予算措置はどうなりますか。' },
        { id: 't3', start: 13, end: 18, speakerId: 'B', text: '当初予算で計上済みです。' },
      ],
    },
  },
]);

check('のりしろの重複発言を除去する',
  merged.filter((s) => s.text.includes('来年3月末')).length === 1, `${merged.length}セグメント`);
check('時刻をグローバルなタイムラインに直す',
  merged.every((s, i) => i === 0 || s.start >= merged[i - 1].start),
  merged.map((s) => s.start.toFixed(1)).join(','));

const speakerOf = (needle) => merged.find((s) => s.text.includes(needle))?.speakerId;
check('チャンクをまたいで話者ラベルを対応付ける',
  speakerOf('来年3月末') === 'A' && speakerOf('予算措置') === 'B' && speakerOf('当初予算') === 'A',
  merged.map((s) => `${s.speakerId}:${s.text.slice(0, 6)}`).join(' / '));

// --- パイプライン統合（上限を小さくして強制的に分割させる）-----------------
const DATA = path.resolve(process.env.DATA_DIR);
const BASE = `http://localhost:${process.env.PORT}`;
const calls = installMockEngine({
  maxUploadBytes: 40_000,
  segments: (index, duration) => [
    { start: 0.5, end: duration / 2, speakerId: 'A', text: `第${index + 1}区間の前半の発言です。` },
    { start: duration / 2, end: Math.max(duration - 0.5, duration / 2 + 0.1), speakerId: 'B', text: `第${index + 1}区間の後半の発言です。` },
  ],
});

fs.rmSync(DATA, { recursive: true, force: true });
await import('../server/index.js');
await new Promise((r) => setTimeout(r, 1200));

const wav = makeAudio('/tmp/koe-chunk-e2e.wav', { durationSec: 20, silences: [[6, 7.5], [13, 14.5]] });
const form = new FormData();
form.append('title', '分割テスト');
form.append('durationSec', '20');
form.append('file', await fs.openAsBlob(wav), 'long.wav');
const created = await (await fetch(`${BASE}/api/jobs`, { method: 'POST', body: form })).json();

const ssePromise = collectSse(`${BASE}/api/jobs/${created.id}/events`);
const job = await waitForJob(BASE, created.id);
const events = await ssePromise;

check('分割モードでも完了する', job.job.status === 'completed', job.job.error?.message || '');
check('実際に複数チャンクへ分けて送信する', calls.length >= 2,
  calls.map((c) => `${c.duration.toFixed(1)}秒/${Math.round(c.bytes / 1024)}KB`).join(' + '));
check('各チャンクがAPI上限に収まる', calls.every((c) => c.bytes <= 40_000),
  `最大 ${Math.max(...calls.map((c) => c.bytes))} bytes`);
check('精度低下の警告を配信する',
  events.some((e) => e.type === 'warning' && /分割/.test(e.data?.message || '')));
check('wasChunked を記録する（UIの警告バッジ用）', job.job.engine.wasChunked === true);
check('セグメントIDを通しで振り直す',
  job.segments.every((s, i) => s.id === `seg_${String(i + 1).padStart(4, '0')}`), `${job.segments.length}件`);
check('時刻が単調増加する',
  job.segments.every((s, i) => i === 0 || s.start >= job.segments[i - 1].start));
check('分割用の一時ファイルを残さない', fs.readdirSync(path.join(DATA, 'tmp')).length === 0);

const md = await (await fetch(`${BASE}/api/jobs/${created.id}/export?format=md`)).text();
check('エクスポートに分割処理の注意書きを入れる', md.includes('分割して処理'));

process.exit(finish() ? 1 : 0);
