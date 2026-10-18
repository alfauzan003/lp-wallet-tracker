import type { Api } from 'grammy';

export type EditResult = 'ok' | 'gone';

/** Both methods reject if delivery failed. */
export interface Notifier {
  /** Resolves to the Telegram message_id. */
  send(html: string): Promise<number>;
  /** 'gone' when the message no longer exists (the owner deleted it). */
  edit(messageId: number, html: string): Promise<EditResult>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Telegram flood-control errors carry `parameters.retry_after` (seconds); detected by shape, not class. */
function retryAfterMs(err: unknown): number | null {
  const v = (err as { parameters?: { retry_after?: unknown } } | null)?.parameters?.retry_after;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v * 1000 : null;
}

/** Telegram API errors carry a `description`; detected by shape, not class. */
function description(err: unknown): string {
  const v = (err as { description?: unknown } | null)?.description;
  return typeof v === 'string' ? v : '';
}

export async function sendWithRetry<T>(
  send: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? defaultSleep;
  for (let i = 1; ; i++) {
    try {
      return await send();
    } catch (err) {
      if (i >= attempts) throw err;
      await sleep(retryAfterMs(err) ?? 1000 * 2 ** (i - 1));
    }
  }
}

export function createTelegramNotifier(
  api: Api,
  chatId: number,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Notifier {
  const other = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;
  const retry = { sleep: opts.sleep };
  return {
    send: (html) => sendWithRetry(async () => (await api.sendMessage(chatId, html, other)).message_id, retry),
    edit: (messageId, html) =>
      sendWithRetry(async (): Promise<EditResult> => {
        try {
          await api.editMessageText(chatId, messageId, html, other);
          return 'ok';
        } catch (err) {
          // Returned, not thrown, so these final answers never reach the retry loop.
          if (/message is not modified/i.test(description(err))) return 'ok';
          if (/message to edit not found/i.test(description(err))) return 'gone';
          throw err;
        }
      }, retry),
  };
}
