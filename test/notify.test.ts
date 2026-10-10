import { describe, expect, it, vi } from 'vitest';
import { createTelegramNotify, sendWithRetry } from '../src/notify.js';

describe('sendWithRetry', () => {
  it('retries then succeeds', async () => {
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('boom1'))
      .mockRejectedValueOnce(new Error('boom2'))
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn(async (_ms: number) => {});
    await sendWithRetry(send, { sleep });
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
  });

  it('honors retry_after', async () => {
    const err = Object.assign(new Error('Too Many Requests'), { parameters: { retry_after: 4 } });
    const send = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ ok: true });
    const sleep = vi.fn(async (_ms: number) => {});
    await sendWithRetry(send, { sleep });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([4000]);
  });

  it('rethrows after attempts', async () => {
    const send = vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('down'));
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(sendWithRetry(send, { sleep })).rejects.toThrow('down');
    expect(send).toHaveBeenCalledTimes(3);
    // no pointless sleep after the final failure
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe('createTelegramNotify', () => {
  it('sends HTML with link previews disabled', async () => {
    const sendMessage = vi.fn(async () => ({}));
    const notify = createTelegramNotify({ sendMessage } as never, 42);
    await notify('<b>hi</b>');
    expect(sendMessage).toHaveBeenCalledWith(42, '<b>hi</b>', {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  });
});
