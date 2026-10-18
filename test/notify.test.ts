import { describe, expect, it, vi } from 'vitest';
import { createTelegramNotifier, sendWithRetry } from '../src/notify.js';

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

  it('returns the value of the successful attempt', async () => {
    const send = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(5);
    await expect(sendWithRetry(send, { sleep: async () => {} })).resolves.toBe(5);
  });
});

describe('createTelegramNotifier', () => {
  const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
  const sleep = async (_ms: number) => {};

  it('send posts HTML with previews disabled and returns message_id', async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 314 }));
    const n = createTelegramNotifier({ sendMessage } as never, 42, { sleep });
    await expect(n.send('<b>hi</b>')).resolves.toBe(314);
    expect(sendMessage).toHaveBeenCalledWith(42, '<b>hi</b>', opts);
  });

  it('edit calls editMessageText with the same options', async () => {
    const editMessageText = vi.fn(async () => ({}));
    const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
    await expect(n.edit(7, '<b>x</b>')).resolves.toBe('ok');
    expect(editMessageText).toHaveBeenCalledWith(42, 7, '<b>x</b>', opts);
  });

  it('edit treats "message is not modified" as ok without retrying', async () => {
    const err = Object.assign(new Error('400'), {
      description:
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
    });
    const editMessageText = vi.fn(async () => {
      throw err;
    });
    const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
    await expect(n.edit(7, 'x')).resolves.toBe('ok');
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it('edit returns gone for "message to edit not found" without retrying', async () => {
    const err = Object.assign(new Error('400'), { description: 'Bad Request: message to edit not found' });
    const editMessageText = vi.fn(async () => {
      throw err;
    });
    const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
    await expect(n.edit(7, 'x')).resolves.toBe('gone');
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

  it('edit rethrows other errors after 3 attempts', async () => {
    const editMessageText = vi.fn(async () => {
      throw new Error('down');
    });
    const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
    await expect(n.edit(7, 'x')).rejects.toThrow('down');
    expect(editMessageText).toHaveBeenCalledTimes(3);
  });
});
