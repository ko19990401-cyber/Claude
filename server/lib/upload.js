import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { SUPPORTED_EXTENSIONS, paths } from '../config.js';

/**
 * multipart のアップロードをディスクへ直接ストリームする。
 * ファイルサイズに上限を設けない方針（FR-01）のため、メモリには載せない。
 */
export function receiveUpload(req, { jobId }) {
  return new Promise((resolve, reject) => {
    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fields: 20 } });
    } catch (err) {
      reject(Object.assign(err, { status: 400 }));
      return;
    }

    const fields = {};
    let filePromise = null;
    let fileInfo = null;
    let rejected = null;

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('file', (_name, stream, info) => {
      const ext = path.extname(info.filename || '').toLowerCase();
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        rejected = Object.assign(
          new Error(`非対応のファイル形式です（${ext || '拡張子なし'}）。対応形式: ${SUPPORTED_EXTENSIONS.join(' / ')}`),
          { status: 415 },
        );
        stream.resume();
        return;
      }
      const dest = path.join(paths.uploads, `${jobId}${ext}`);
      fileInfo = { fileName: info.filename, ext, path: dest, mimeType: info.mimeType };
      filePromise = pipeline(stream, fs.createWriteStream(dest)).then(async () => {
        const stat = await fs.promises.stat(dest);
        return { ...fileInfo, bytes: stat.size };
      });
    });

    busboy.on('error', reject);

    busboy.on('close', async () => {
      if (rejected) {
        reject(rejected);
        return;
      }
      if (!filePromise) {
        reject(Object.assign(new Error('ファイルが含まれていません。'), { status: 400 }));
        return;
      }
      try {
        resolve({ fields, file: await filePromise });
      } catch (err) {
        reject(err);
      }
    });

    req.pipe(busboy);
  });
}
