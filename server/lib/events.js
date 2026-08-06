import { EventEmitter } from 'node:events';

/**
 * ジョブ進捗のSSE配信バス。
 *
 * ブラウザを閉じて開き直しても経過が追えるよう、ジョブごとに直近のイベントを
 * リングバッファに保持し、購読開始時にまとめて流す（FR-11）。
 */
const HISTORY_LIMIT = 300;

const bus = new EventEmitter();
bus.setMaxListeners(0);

const history = new Map(); // jobId -> event[]

export function emitJobEvent(jobId, type, payload = {}) {
  const event = { type, at: new Date().toISOString(), ...payload };
  const buf = history.get(jobId) || [];
  buf.push(event);
  if (buf.length > HISTORY_LIMIT) buf.splice(0, buf.length - HISTORY_LIMIT);
  history.set(jobId, buf);
  bus.emit(jobId, event);
  return event;
}

export function getHistory(jobId) {
  return history.get(jobId) || [];
}

export function subscribe(jobId, listener) {
  bus.on(jobId, listener);
  return () => bus.off(jobId, listener);
}

export function clearHistory(jobId) {
  history.delete(jobId);
}
