import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Tailscale の状態を調べ、スマートフォンから開くURLを割り出す。
 *
 * `tailscale serve` を使うと tailnet 内向けに HTTPS で公開され、正規の証明書が付く。
 * HTTPSであることは見た目の問題ではなく、完了通知（Notification API）と
 * クリップボードコピーが「安全なコンテキスト」でしか動かないため必須。
 *
 * Tailscale が入っていない環境では何もしない（best-effort）。
 */
export async function detectTailnet(port) {
  let status;
  try {
    const { stdout } = await run('tailscale', ['status', '--json'], { timeout: 2000 });
    status = JSON.parse(stdout);
  } catch {
    return null; // 未インストール、未ログイン、権限不足など
  }

  const dns = String(status?.Self?.DNSName || '').replace(/\.$/, '');
  if (!dns) return null;

  let served = false;
  try {
    const { stdout } = await run('tailscale', ['serve', 'status'], { timeout: 2000 });
    served = new RegExp(`(127\\.0\\.0\\.1|localhost):${port}\\b`).test(stdout);
  } catch {
    // serve が未設定ならエラー終了するので、そのまま false 扱い
  }

  return {
    dns,
    ips: status?.Self?.TailscaleIPs || [],
    served,
    url: served ? `https://${dns}` : null,
  };
}
