import { execFileSync } from 'node:child_process';

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

export function createChecker(title) {
  const results = [];
  console.log(`\n${DIM}── ${title} ${'─'.repeat(Math.max(0, 56 - title.length))}${RESET}`);
  return {
    check(name, ok, detail = '') {
      results.push({ name, ok });
      console.log(`  ${ok ? `${GREEN}✔${RESET}` : `${RED}✘${RESET}`} ${name}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`);
    },
    finish() {
      const failed = results.filter((r) => !r.ok);
      console.log(`  ${results.length - failed.length}/${results.length} passed`);
      return failed.length;
    },
  };
}

/** ffmpeg が無い環境ではテストを飛ばす（CIや未設定環境向け）。 */
export function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function makeAudio(output, { durationSec = 20, silences = [], stereo = true, encode = false } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${durationSec}`];
  if (silences.length) {
    const expr = silences.map(([a, b]) => `between(t,${a},${b})`).join('+');
    args.push('-af', `volume=0:enable='${expr}'`);
  }
  args.push('-ac', stereo ? '2' : '1', '-ar', stereo ? '44100' : '16000');
  if (encode) args.push('-c:a', 'libopus', '-b:a', '24k');
  args.push(output);
  execFileSync('ffmpeg', args);
  return output;
}

export const probeDuration = (file) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', file]).toString().trim());

/** SSEのフレームを収集する。completed / failed が来たら終了。 */
export async function collectSse(url, { stopOn = ['completed', 'failed'], timeoutMs = 60000 } = {}) {
  const events = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const type = /event:\s*(\S+)/.exec(frame)?.[1];
        const data = /data:\s*(.+)/.exec(frame)?.[1];
        if (type) events.push({ type, data: data ? JSON.parse(data) : null });
      }
      if (events.some((e) => stopOn.includes(e.type))) break;
    }
  } catch {
    // タイムアウト・切断はそのまま集めた分を返す
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

export async function waitForJob(base, jobId, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let job;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    job = await (await fetch(`${base}/api/jobs/${jobId}`)).json();
    if (['completed', 'failed'].includes(job.job.status)) return job;
  }
  return job;
}
