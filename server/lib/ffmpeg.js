import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { config } from '../config.js';

/** ffmpeg の標準エラー出力に現れる `time=00:12:34.56` を秒に直す。 */
function parseTime(line) {
  const m = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(line);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function run(bin, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      const text = String(d);
      stderr += text;
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
      if (onStderr) text.split(/\r|\n/).forEach((line) => line && onStderr(line));
    });
    child.on('error', (err) =>
      reject(
        Object.assign(new Error(`${bin} を起動できませんでした: ${err.message}`), {
          code: 'FFMPEG_NOT_FOUND',
        }),
      ),
    );
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${bin} が異常終了しました (code ${code})\n${stderr.slice(-2000)}`), { code: 'FFMPEG_FAILED' }));
    });
  });
}

let ffmpegStatus = null;

/** 起動時チェック（§11 エラー処理：ffmpeg未インストール）。 */
export async function checkFfmpeg({ force = false } = {}) {
  if (ffmpegStatus && !force) return ffmpegStatus;
  try {
    const { stdout, stderr } = await run(config.ffmpegPath, ['-version']);
    const version = (stdout || stderr).split('\n')[0]?.trim() || 'unknown';
    ffmpegStatus = { ok: true, version };
  } catch (err) {
    ffmpegStatus = { ok: false, error: err.message };
  }
  return ffmpegStatus;
}

/** 再生時間（秒）を取得する。ffprobe が無い環境では ffmpeg の出力から拾う。 */
export async function probeDuration(file) {
  try {
    const { stdout } = await run(config.ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    const sec = Number(String(stdout).trim());
    if (Number.isFinite(sec) && sec > 0) return sec;
  } catch {
    // ffprobe が無いだけなら ffmpeg にフォールバックする
  }
  let last = null;
  await run(config.ffmpegPath, ['-i', file, '-f', 'null', '-'], {
    onStderr: (line) => {
      const t = parseTime(line);
      if (t !== null) last = t;
    },
  }).catch(() => {});
  return last || 0;
}

/**
 * FR-02 音声前処理。モノラル / 16kHz / Opus 24kbps へ正規化する。
 * 1時間のWAV(44.1kHz/ステレオ) 約600MB → 約10MB。
 */
export async function preprocess(input, output, { durationSec = 0, onProgress } = {}) {
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libopus',
    '-b:a', '24k',
    output,
  ];
  await run(config.ffmpegPath, args, {
    onStderr: (line) => {
      const t = parseTime(line);
      if (t !== null && onProgress) {
        onProgress({ processedSec: t, ratio: durationSec ? Math.min(t / durationSec, 1) : null });
      }
    },
  });
  const stat = await fs.stat(output);
  return { bytes: stat.size };
}

/**
 * 無音区間を検出する（FR-03 の分割フォールバック用）。
 * 返り値は [{ start, end }] の配列（秒）。
 */
export async function detectSilences(file, {
  thresholdDb = config.silenceThresholdDb,
  minDurSec = config.silenceMinDurSec,
} = {}) {
  const silences = [];
  let pendingStart = null;
  await run(config.ffmpegPath, [
    '-hide_banner', '-nostdin',
    '-i', file,
    '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDurSec}`,
    '-f', 'null', '-',
  ], {
    onStderr: (line) => {
      const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
      if (start) pendingStart = Number(start[1]);
      const end = /silence_end:\s*([\d.]+)/.exec(line);
      if (end && pendingStart !== null) {
        silences.push({ start: pendingStart, end: Number(end[1]) });
        pendingStart = null;
      }
    },
  });
  return silences;
}

/** 音声の一部を切り出す（分割送信用）。 */
export async function sliceAudio(input, output, startSec, endSec) {
  const args = [
    '-hide_banner', '-nostdin', '-y',
    '-ss', String(Math.max(0, startSec)),
  ];
  if (Number.isFinite(endSec)) args.push('-to', String(endSec));
  args.push('-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', output);
  await run(config.ffmpegPath, args);
  const stat = await fs.stat(output);
  return { bytes: stat.size };
}
