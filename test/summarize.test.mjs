/**
 * FR-07 / FR-08 要約パイプラインのテスト。
 * Anthropic API をローカルのモックに差し替え、ストリーミング・プロンプトキャッシュ・
 * 階層要約（Map→Reduce）・中間要約の再利用を検証する。
 * 実行: ANTHROPIC_BASE_URL=http://localhost:8790 node test/summarize.test.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createChecker } from './helpers.mjs';

// --- Anthropic API のモック ------------------------------------------------
const calls = [];
const mock = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  calls.push({ url: req.url, body });

  const userText = body.messages[0].content.map((b) => b.text).join('\n');
  const reply = userText.includes('事実の抽出')
    ? `- 抽出された事実（呼び出し${calls.length}） [00:01:00]`
    : '# 復命書\n\n## 1 用務\n定例会への出席 [00:00:00]\n\n## 5 内容\n- 移行期限は令和9年3月末 [00:00:48]\n';

  const usage = {
    input_tokens: 1200,
    output_tokens: 300,
    cache_creation_input_tokens: body.messages[0].content.some((b) => b.cache_control) ? 900 : 0,
    cache_read_input_tokens: 0,
  };

  if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage },
    });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    for (const piece of reply.match(/[\s\S]{1,20}/g)) {
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } });
      await new Promise((r) => setTimeout(r, 3));
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage });
    send('message_stop', { type: 'message_stop' });
    res.end();
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
      content: [{ type: 'text', text: reply }], stop_reason: 'end_turn', stop_sequence: null, usage,
    }));
  }
});
await new Promise((r) => mock.listen(8790, r));

const { generateSummary, renderTranscript, splitForMap } = await import('../server/llm/summarize.js');
const { ensureDirs, getIntermediate } = await import('../server/lib/store.js');

const DATA = path.resolve(process.env.DATA_DIR);
fs.rmSync(DATA, { recursive: true, force: true });
await ensureDirs();
fs.mkdirSync(path.join(DATA, 'jobs', 'job_test'), { recursive: true });

const { check, finish } = createChecker('要約パイプライン（FR-07 / FR-08）');

const job = { id: 'job_test', title: 'テスト会議' };
const speakers = [{ id: 'A', label: '議長' }, { id: 'B', label: '話者B' }];
const mkSegments = (n) => Array.from({ length: n }, (_, i) => ({
  id: `seg_${i}`,
  start: i * 5,
  end: i * 5 + 4,
  speakerId: i % 2 ? 'B' : 'A',
  text: `発言${i}：自治体情報システム標準化の進捗について、来年3月末までの移行完了を目指します。`,
}));

// --- 一括要約 -------------------------------------------------------------
const shortSegments = mkSegments(20);
const streamed = [];
const single = await generateSummary({
  job, segments: shortSegments, speakers, presetId: 'report',
  onEvent: (e) => streamed.push(e.type),
});

check('一括要約を生成する', single.body.includes('復命書'), `${single.body.length}字`);
check('パイプライン判定は single', single.pipeline === 'single');
check('生成過程をストリーミングで流す', streamed.filter((t) => t === 'delta').length > 3,
  `${streamed.filter((t) => t === 'delta').length}差分`);
check('文字起こしをプロンプトキャッシュ対象にする',
  calls[0].body.messages[0].content[0].cache_control?.type === 'ephemeral');
check('文字起こしとプリセット指示を別ブロックに分ける',
  calls[0].body.messages[0].content.length === 2);
check('adaptive thinking と effort を送る',
  calls[0].body.thinking?.type === 'adaptive' && Boolean(calls[0].body.output_config?.effort),
  `effort=${calls[0].body.output_config?.effort}`);
check('共通の生成ルールを常にシステムプロンプトへ含める',
  ['推測', '聞き取り不明', '[HH:MM:SS]'].every((k) => calls[0].body.system.map((b) => b.text).join('').includes(k)));
check('使用量を円で記録する', single.usage.jpy > 0,
  `${single.usage.jpy}円 / 出力${single.usage.outputTokens}トークン`);
check('本文にタイムスタンプが残る', /\[\d\d:\d\d:\d\d\]/.test(single.body));

// --- 階層要約 -------------------------------------------------------------
const longSegments = mkSegments(120);
const transcript = renderTranscript(longSegments, speakers);
check('閾値を超える長さを用意', transcript.length > Number(process.env.HIERARCHICAL_THRESHOLD),
  `${transcript.length}字 > 閾値${process.env.HIERARCHICAL_THRESHOLD}字`);

const chunks = splitForMap(transcript, { chunkChars: 1200, overlapChars: 400 });
check('話者ターン境界を尊重して分割する', chunks.length > 1 && chunks.every((c) => c.body.startsWith('[')),
  `${chunks.length}分割`);
check('前チャンク末尾をオーバーラップとして付与する', chunks[1].text.includes('（前の部分の末尾）'));

calls.length = 0;
const phases = [];
const hierarchical = await generateSummary({
  job, segments: longSegments, speakers, presetId: 'minutes',
  onEvent: (e) => { if (e.type !== 'delta') phases.push(e.type); },
});

check('パイプライン判定は hierarchical', hierarchical.pipeline === 'hierarchical', `${hierarchical.chunkCount}分割`);
check('Map → Reduce の進捗を通知する',
  ['map:start', 'map:progress', 'reduce:start'].every((t) => phases.includes(t)), phases.join(','));
check('Mapは非ストリーミング、Reduceはストリーミング',
  calls.slice(0, -1).every((c) => !c.body.stream) && calls[calls.length - 1].body.stream === true);
check('Mapは effort=low でコストを抑える', calls[0].body.output_config?.effort === 'low');
check('中間要約を保存する', (await getIntermediate('job_test'))?.chunks.length === hierarchical.chunkCount);

// --- プリセット変更時はMapを再実行しない（FR-08）---------------------------
const mapCallsFirst = calls.filter((c) => !c.body.stream).length;
calls.length = 0;
const phases2 = [];
const again = await generateSummary({
  job, segments: longSegments, speakers, presetId: 'actions',
  onEvent: (e) => { if (e.type !== 'delta') phases2.push(e.type); },
});
check('プリセット変更時は中間要約を再利用しMapを飛ばす',
  phases2.includes('map:cached') && calls.filter((c) => !c.body.stream).length === 0,
  `1回目 Map ${mapCallsFirst}回 → 2回目 0回`);
check('再生成でも分割数は同じ', again.chunkCount === hierarchical.chunkCount);

// --- 文字起こしが変わればMapをやり直す ------------------------------------
calls.length = 0;
const phases3 = [];
await generateSummary({
  job,
  segments: longSegments.map((s, i) => (i === 0 ? { ...s, text: '（修正済み）冒頭を書き換えました。' } : s)),
  speakers,
  presetId: 'minutes',
  onEvent: (e) => { if (e.type !== 'delta') phases3.push(e.type); },
});
check('文字起こしを編集したらMapを再実行する',
  phases3.includes('map:start') && !phases3.includes('map:cached'));

// --- 自由記述プリセット ---------------------------------------------------
let rejected = false;
try {
  await generateSummary({ job, segments: shortSegments, speakers, presetId: 'custom', customPrompt: '  ' });
} catch (err) {
  rejected = /プロンプト/.test(err.message);
}
check('自由記述はプロンプト必須', rejected);

calls.length = 0;
await generateSummary({ job, segments: shortSegments, speakers, presetId: 'custom', customPrompt: '5点にまとめて' });
check('自由記述プロンプトが指示として渡る',
  calls[0].body.messages[0].content[1].text.includes('5点にまとめて'));

mock.close();
process.exit(finish() ? 1 : 0);
