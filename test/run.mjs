/**
 * テストランナー。各スイートを独立プロセスで実行する
 * （それぞれサーバを起動するため、ポートとデータディレクトリを分ける）。
 *
 *   npm test
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hasFfmpeg } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];

const SUITES = [
  {
    name: 'pipeline',
    file: 'test/pipeline.test.mjs',
    needsFfmpeg: true,
    env: { DATA_DIR: './.test-data/pipeline', ASR_PROVIDER: 'mock', PORT: '8791' },
  },
  {
    name: 'chunking',
    file: 'test/chunking.test.mjs',
    needsFfmpeg: true,
    env: { DATA_DIR: './.test-data/chunking', ASR_PROVIDER: 'mock', PORT: '8792' },
  },
  {
    name: 'summarize',
    file: 'test/summarize.test.mjs',
    needsFfmpeg: false,
    env: {
      DATA_DIR: './.test-data/summarize',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      ANTHROPIC_BASE_URL: 'http://localhost:8790',
      HIERARCHICAL_THRESHOLD: '4000',
      CHUNK_CHARS: '1200',
    },
  },
  {
    name: 'ui',
    file: 'test/ui.test.mjs',
    needsFfmpeg: true,
    env: { DATA_DIR: './.test-data/ui', PORT: '8793', SHOTS_DIR: './.test-data/shots' },
  },
];

const ffmpeg = hasFfmpeg();
if (!ffmpeg) console.log('[33m! ffmpeg が無いため、音声を伴うスイートはスキップします[0m');

fs.mkdirSync(path.join(ROOT, '.test-data/shots'), { recursive: true });

let failures = 0;
for (const suite of SUITES) {
  if (only && suite.name !== only) continue;
  if (suite.needsFfmpeg && !ffmpeg) {
    console.log(`\n  ⤳ ${suite.name} をスキップ（ffmpeg 未インストール）`);
    continue;
  }
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [suite.file], {
      cwd: ROOT,
      env: { ...process.env, ...suite.env },
      stdio: 'inherit',
    });
    child.on('close', resolve);
  });
  if (code !== 0) failures += 1;
}

console.log(failures ? `\n[31m${failures} スイートが失敗しました[0m` : '\n[32mすべてのスイートが成功しました[0m');
process.exit(failures ? 1 : 0);
