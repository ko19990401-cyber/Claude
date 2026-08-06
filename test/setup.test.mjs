/**
 * `npm run setup` のテスト。
 * .env の書き換えが既存の設定やコメントを壊さないこと、
 * 非対話モードで状態を正しく報告することを確認する。
 * 実行: DATA_DIR=./.test-data/setup node test/setup.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createChecker } from './helpers.mjs';
import { readEnvValue, upsertEnv } from '../tools/setup.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR);

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

const { check, finish } = createChecker('npm run setup（初回セットアップ）');

// --- .env の書き換え ---------------------------------------------------------
const sample = `# コメント
ASR_PROVIDER=elevenlabs

# 第一候補
ELEVENLABS_API_KEY=
ANTHROPIC_API_KEY=

USD_JPY=150
`;

const afterFirst = upsertEnv(sample, 'ELEVENLABS_API_KEY', 'sk_eleven_abcdef');
check('空のキーに値を書き込む', readEnvValue(afterFirst, 'ELEVENLABS_API_KEY') === 'sk_eleven_abcdef');
check('コメントを残す', afterFirst.includes('# 第一候補') && afterFirst.includes('# コメント'));
check('他の設定を壊さない',
  readEnvValue(afterFirst, 'ASR_PROVIDER') === 'elevenlabs' && readEnvValue(afterFirst, 'USD_JPY') === '150');
check('行数を増やさない（既存行を置換する）',
  afterFirst.split('\n').length === sample.split('\n').length);

const afterSecond = upsertEnv(afterFirst, 'ANTHROPIC_API_KEY', 'sk-ant-xyz');
check('2つ目のキーも独立して書き込める',
  readEnvValue(afterSecond, 'ELEVENLABS_API_KEY') === 'sk_eleven_abcdef'
  && readEnvValue(afterSecond, 'ANTHROPIC_API_KEY') === 'sk-ant-xyz');

const overwritten = upsertEnv(afterSecond, 'ANTHROPIC_API_KEY', 'sk-ant-new');
check('既存の値を上書きできる', readEnvValue(overwritten, 'ANTHROPIC_API_KEY') === 'sk-ant-new');
check('上書きしても重複行を作らない',
  (overwritten.match(/^ANTHROPIC_API_KEY=/gm) || []).length === 1);

const appended = upsertEnv(sample, 'AUTH_PASSWORD', 'secret');
check('存在しないキーは末尾に追加する', readEnvValue(appended, 'AUTH_PASSWORD') === 'secret');

check('コメントアウトされた行は値として読まない',
  readEnvValue('# ANTHROPIC_API_KEY=commented\nANTHROPIC_API_KEY=real\n', 'ANTHROPIC_API_KEY') === 'real');

// --- 非対話モードでの実行 ----------------------------------------------------
// 一時的な作業ディレクトリを作り、本物の .env を触らずに検証する
const sandbox = path.join(DATA, 'sandbox');
fs.mkdirSync(path.join(sandbox, 'tools'), { recursive: true });
fs.mkdirSync(path.join(sandbox, 'server', 'lib'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'tools/setup.mjs'), path.join(sandbox, 'tools/setup.mjs'));
fs.copyFileSync(path.join(ROOT, 'server/lib/tailscale.js'), path.join(sandbox, 'server/lib/tailscale.js'));
fs.writeFileSync(path.join(sandbox, '.env.example'), sample);

const result = await run(process.execPath, ['tools/setup.mjs'], {
  cwd: sandbox,
  env: { ...process.env, PATH: '/usr/bin:/bin' }, // ffmpeg も tailscale も無い状態
}).catch((err) => ({ stdout: err.stdout || '', stderr: err.stderr || '', failed: true }));

const output = `${result.stdout}${result.stderr}`;
check('非対話モードでも停止せずに終了する', output.includes('セットアップ'));
check('.env を自動生成する', fs.existsSync(path.join(sandbox, '.env')));
check('未設定のAPIキーを列挙する',
  output.includes('ELEVENLABS') || output.includes('文字起こし（ElevenLabs Scribe）：未設定'));
check('APIキーの取得先URLを案内する', output.includes('console.anthropic.com'));
check('ffmpeg が無い場合は導入方法を示す', /ffmpeg/i.test(output));

// 既にキーが入っていれば「設定済み」と表示し、値は伏せる
fs.writeFileSync(path.join(sandbox, '.env'),
  upsertEnv(upsertEnv(sample, 'ELEVENLABS_API_KEY', 'sk_eleven_1234567890'), 'ANTHROPIC_API_KEY', 'sk-ant-0987654321'));
const second = await run(process.execPath, ['tools/setup.mjs'], {
  cwd: sandbox,
  env: { ...process.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
}).catch((err) => ({ stdout: err.stdout || '', stderr: err.stderr || '' }));
const secondOutput = `${second.stdout}${second.stderr}`;
check('設定済みのキーは再入力を求めない', secondOutput.includes('設定済み'));
check('キーを画面に出さない（伏せ字にする）',
  !secondOutput.includes('sk_eleven_1234567890') && secondOutput.includes('…'));
check('既存の .env を上書きしない',
  readEnvValue(fs.readFileSync(path.join(sandbox, '.env'), 'utf8'), 'ELEVENLABS_API_KEY') === 'sk_eleven_1234567890');

process.exit(finish() ? 1 : 0);
