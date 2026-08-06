/** `npm run doctor` — 起動前の環境チェックをまとめて行う。 */
import { config } from './config.js';
import { listEngines } from './asr/index.js';
import { checkFfmpeg } from './lib/ffmpeg.js';
import { ensureDirs } from './lib/store.js';

const mark = (ok) => (ok ? '[32m✔[0m' : '[31m✘[0m');

const ffmpeg = await checkFfmpeg();
console.log(`${mark(ffmpeg.ok)} ffmpeg  ${ffmpeg.ok ? ffmpeg.version : ffmpeg.error}`);
if (!ffmpeg.ok) {
  console.log('    macOS: brew install ffmpeg');
  console.log('    Ubuntu/Debian: sudo apt install ffmpeg');
  console.log('    Windows: winget install Gyan.FFmpeg');
}

for (const engine of listEngines()) {
  const suffix = engine.isDefault ? '（既定）' : '';
  console.log(`${mark(engine.configured)} ${engine.label}${suffix}  ${engine.configured ? 'APIキー設定済み' : 'APIキー未設定'}`);
}

console.log(`${mark(Boolean(config.keys.anthropic))} Anthropic API  ${config.keys.anthropic ? `モデル ${config.summaryModel}` : 'ANTHROPIC_API_KEY 未設定'}`);

await ensureDirs();
console.log(`${mark(true)} データディレクトリ  ${config.dataDir}`);

const active = listEngines().find((e) => e.isDefault);
const ready = ffmpeg.ok && active?.configured;
console.log(ready ? '\n準備完了です。npm run dev で起動してください。' : '\n上の ✘ を解消してから起動してください。');
process.exit(ready ? 0 : 1);
