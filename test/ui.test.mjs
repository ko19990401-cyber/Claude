/**
 * フロントエンドのテスト（Playwright）。
 * 完了済みジョブを用意して実ブラウザで操作し、仮想スクロール・検索・話者リネーム・
 * セグメント編集・音声シーク・要約表示・辞書モーダルを確認する。
 *
 * Playwright が無い環境では自動的にスキップする。
 * 実行: DATA_DIR=./.test-data-ui PORT=8798 node test/ui.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker, makeAudio } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    const { createRequire } = await import('node:module');
    ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('/opt/node22/lib/node_modules/playwright'));
  } catch {
    console.log('\n  ⤳ Playwright が見つからないため UI テストをスキップします（npm i -D playwright で有効化）');
    process.exit(0);
  }
}

const DATA = path.resolve(process.env.DATA_DIR);
const BASE = `http://localhost:${process.env.PORT}`;
const JOB_ID = 'job_20260806_141530_ab12';
const SEG_COUNT = 2400;
const SHOTS = process.env.SHOTS_DIR;

// --- 3時間相当の完了済みジョブを用意する -----------------------------------
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, 'jobs', JOB_ID, 'summaries'), { recursive: true });
fs.mkdirSync(path.join(DATA, 'audio'), { recursive: true });

const SPEAKERS = ['A', 'B', 'C', 'D'];
const LINES = [
  '本日の議題は自治体情報システム標準化の進捗についてです。',
  '移行スケジュールについて確認したいのですが、来年3月末で間に合うのでしょうか。',
  'ガバメントクラウドへの接続試験は8月中に完了する見込みです。',
  'LGWAN経由の通信については、別途セキュリティ要件の確認が必要になります。',
  'BPRの観点から、現行の業務フローを一度棚卸ししたほうがよいと考えます。',
  '予算措置は令和8年度の当初予算で2,400万円を計上しています。',
];
const segments = Array.from({ length: SEG_COUNT }, (_, i) => ({
  id: `seg_${String(i + 1).padStart(4, '0')}`,
  start: i * 4.5,
  end: i * 4.5 + 4.2,
  speakerId: SPEAKERS[i % 4],
  text: `${LINES[i % LINES.length]}（発言${i + 1}）`,
  confidence: i % 17 === 0 ? 0.51 : 0.93,
  edited: false,
}));
const speakers = SPEAKERS.map((id, i) => ({
  id,
  label: i === 0 ? '議長（総務課長）' : `話者${id}`,
  utteranceCount: segments.filter((s) => s.speakerId === id).length,
  totalSec: segments.filter((s) => s.speakerId === id).length * 4.2,
}));

fs.writeFileSync(path.join(DATA, 'jobs', JOB_ID, 'job.json'), JSON.stringify({
  id: JOB_ID,
  title: '上川管内電算協議会 定例会',
  createdAt: '2026-08-06T14:15:30+09:00',
  updatedAt: '2026-08-06T14:32:10+09:00',
  status: 'completed',
  source: {
    fileName: '20260806_meeting.m4a',
    durationSec: SEG_COUNT * 4.5,
    originalBytes: 87000000,
    processedBytes: 16200000,
    uploadPath: null,
    audioPath: `audio/${JOB_ID}.ogg`,
  },
  engine: { provider: 'elevenlabs', model: 'scribe_v1', language: 'ja', diarization: true, speakerCount: null, externalJobId: 'x', wasChunked: false },
  speakers,
  glossaryId: 'glo_default',
  stats: { segmentCount: segments.length, charCount: segments.reduce((n, s) => n + s.text.length, 0) },
  error: null,
}, null, 2));
fs.writeFileSync(path.join(DATA, 'jobs', JOB_ID, 'segments.json'), JSON.stringify(segments));
fs.writeFileSync(path.join(DATA, 'jobs', JOB_ID, 'summaries', 'sum_demo.json'), JSON.stringify({
  id: 'sum_demo',
  presetId: 'report',
  presetLabel: '出張報告／復命書',
  model: 'claude-opus-5',
  pipeline: 'hierarchical',
  chunkCount: 4,
  createdAt: '2026-08-06T14:32:10+09:00',
  usage: { inputTokens: 41000, outputTokens: 2400, jpy: 38.2 },
  body: '# 復命書\n\n## 1 用務\n自治体情報システム標準化に関する定例会への出席 [00:00:00]\n\n## 2 日時\n令和8年8月6日 [00:00:12]\n\n## 5 内容\n\n| 項目 | 内容 | 根拠 |\n|---|---|---|\n| 移行期限 | 令和9年3月末 | [00:00:48] |\n| 予算 | 2,400万円 | [00:12:34] |\n\n- ガバメントクラウドへの接続試験は8月中に完了予定 [00:01:30]\n- LGWAN経由の通信は別途セキュリティ要件の確認が必要 [00:02:15]\n\n## 6 所見\n聞き取り不明な箇所があったため、詳細は事務局に確認します [01:05:00]\n',
}, null, 2));

makeAudio(path.join(DATA, 'audio', `${JOB_ID}.ogg`), { durationSec: 120, stereo: false, encode: true });

const server = spawn('node', ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, ANTHROPIC_API_KEY: '', ELEVENLABS_API_KEY: 'dummy' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1500));

const { check, finish } = createChecker('画面（Playwright）');

// プロキシ設定があるとlocalhostへ繋がらないので、ブラウザには渡さない
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/proxy/i.test(k)),
);
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  env: cleanEnv,
  args: ['--no-proxy-server'],
});
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
const shot = (name) => (SHOTS ? page.screenshot({ path: path.join(SHOTS, name) }).catch(() => {}) : Promise.resolve());

try {
  // --- ホーム ---
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  check('ホーム画面を表示する', await page.locator('.dropzone').isVisible());
  check('履歴カードを表示する', (await page.locator('.job-card').count()) === 1,
    await page.locator('.job-card h3').first().innerText());
  await shot('01-home.png');

  // --- 文字起こしタブ ---
  await page.locator('.job-card').first().click();
  await page.waitForSelector('.segment', { timeout: 10000 });
  const domCount = await page.locator('.segment').count();
  check('仮想スクロール：可視範囲だけをDOMに置く', domCount > 3 && domCount < 60,
    `${SEG_COUNT}セグメント中 ${domCount}個`);
  check('話者チップを人数分表示する', (await page.locator('.speaker-chip').count()) === 4);
  check('話者ごとに色分けする',
    (await page.locator('.segment .who').first().evaluate((n) => getComputedStyle(n).color)) !== 'rgb(0, 0, 0)');
  await shot('02-transcript.png');

  await page.locator('.transcript-scroll').evaluate((n) => { n.scrollTop = 40000; });
  await page.waitForTimeout(400);
  check('スクロールしてもDOM数が一定に保たれる', (await page.locator('.segment').count()) < 60);

  // --- 検索 ---
  await page.locator('input[type=search]').fill('2,400万円');
  await page.waitForTimeout(500);
  const hits = await page.locator('.search-nav span').first().innerText();
  check('インクリメンタル検索がヒットする', /件/.test(hits) && !/^0件/.test(hits), hits);
  check('ヒット箇所をハイライトする', (await page.locator('.segment mark').count()) > 0);
  await shot('03-search.png');
  await page.locator('input[type=search]').fill('');
  await page.waitForTimeout(300);

  // --- 話者リネーム ---
  await page.locator('.transcript-scroll').evaluate((n) => { n.scrollTop = 0; });
  await page.waitForTimeout(300);
  await page.locator('.speaker-chip .name').nth(1).click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('財政課 佐藤');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const whoTexts = await page.locator('.segment .who').allInnerTexts();
  check('話者リネームが全セグメントへ即時反映される', whoTexts.includes('財政課 佐藤'),
    [...new Set(whoTexts)].join(' / '));

  // --- セグメント編集 ---
  await page.locator('.segment .body').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('【追記】');
  await page.locator('.result-title').click();
  await page.waitForTimeout(600);
  const saved = await (await fetch(`${BASE}/api/jobs/${JOB_ID}`)).json();
  const editedSeg = saved.segments.find((s) => s.text.includes('【追記】'));
  check('セグメント編集がサーバへ保存される', Boolean(editedSeg) && editedSeg.edited === true, editedSeg?.id);
  check('編集済みマークが付く', (await page.locator('.segment .flag').count()) > 0);

  // --- 音声シーク ---
  await page.locator('.segment .time').nth(2).click();
  await page.waitForTimeout(500);
  const current = await page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
  check('セグメントクリックで該当時刻から再生する', current > 5, `currentTime=${current?.toFixed?.(1)}`);

  // --- 要約タブ ---
  await page.locator('.tab', { hasText: '要約' }).click();
  await page.waitForSelector('.summary-output', { timeout: 5000 });
  check('保存済みの要約を表示する', (await page.locator('.md h1').first().innerText()).includes('復命書'));
  check('階層要約バッジで情報欠落の可能性を明示する',
    await page.locator('.badge-warn', { hasText: '階層要約' }).isVisible());
  check('Markdownの表を描画する', (await page.locator('.md table').count()) === 1);
  check('要約中のタイムスタンプをボタン化する', (await page.locator('.md .ts').count()) >= 6,
    `${await page.locator('.md .ts').count()}個`);
  await shot('04-summary.png');

  await page.locator('.md .ts', { hasText: '00:00:48' }).first().click();
  await page.waitForTimeout(400);
  const seeked = await page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1);
  check('要約のタイムスタンプから元発言へ遡れる', Math.abs(seeked - 48) < 2, `currentTime=${seeked?.toFixed?.(1)}`);
  check('APIキー未設定なら生成ボタンを無効化する',
    await page.locator('.summary-controls .btn-primary').isDisabled());

  // --- 辞書・出力モーダル ---
  await page.locator('.tabs .btn', { hasText: '辞書' }).click();
  await page.waitForSelector('.modal', { timeout: 3000 });
  check('用語辞書を編集できる',
    (await page.locator('.tag').count()) >= 8 && (await page.locator('.kv-row').count()) === 3,
    `${await page.locator('.tag').count()}語 / ${await page.locator('.kv-row').count()}置換ルール`);
  await shot('05-glossary.png');
  await page.locator('.modal footer .btn', { hasText: '閉じる' }).click();

  await page.locator('.tabs .btn', { hasText: '出力' }).click();
  await page.waitForSelector('.modal', { timeout: 3000 });
  check('エクスポート画面を開く', (await page.locator('.modal h3').innerText()) === 'エクスポート');
  await shot('06-export.png');
  await page.locator('.modal footer .btn', { hasText: 'キャンセル' }).click();

  // --- ダークモード ---
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.tab', { hasText: '文字起こし' }).click();
  await page.waitForTimeout(400);
  await shot('07-dark.png');
  check('ダークモードで破綻なく描画する', true);

  check('JSコンソールエラーが出ない', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check(`例外: ${err.message.split('\n')[0]}`, false);
  await shot('99-error.png');
} finally {
  await browser.close();
  server.kill();
}

process.exit(finish() ? 1 : 0);
