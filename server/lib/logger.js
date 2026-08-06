const COLORS = { info: '[36m', warn: '[33m', error: '[31m', ok: '[32m' };
const RESET = '[0m';

const stamp = () => new Date().toISOString().slice(11, 19);

function write(level, args) {
  const color = COLORS[level] || '';
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(`${color}[${stamp()}] ${level.toUpperCase()}${RESET} ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`);
}

export const log = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  error: (...a) => write('error', a),
  ok: (...a) => write('ok', a),
};
