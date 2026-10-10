import type { Api } from 'grammy';
import type { Notify } from './poller.js';

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Telegram flood-control errors carry `parameters.retry_after` (seconds); detected by shape, not class. */
function retryAfterMs(err: unknown): number | null {
  const v = (err as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * 1000 : null;
}

export async function sendWithRetry(
  send: () => Promise<unknown>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 1; ; i++) {
    try {
      await send();
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(retryAfterMs(err) ?? 1000 * 2 ** (i - 1));
    }
  }
}

export function createTelegramNotify(api: Api, chatId: number): Notify {
  return (html) =>
    sendWithRetry(() =>
      api.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      }),
    );
}
