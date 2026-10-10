import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ClosedPosition, OpenPosition } from '../src/lpagent/types.js';
import { LpAgentError, type LpAgentClient } from '../src/lpagent/client.js';
import { openDb, type Db } from '../src/db.js';
import { createPoller } from '../src/poller.js';
import { makePosition, makeRow } from './fixtures/make.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const T0 = new Date('2026-10-10T00:00:00.000Z');
const SEEN = '2026-10-09T00:00:00.000Z';

function closedOf(p: OpenPosition, overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    tokenId: p.tokenId,
    protocol: p.protocol,
    createdAt: p.createdAt,
    closeAt: '2026-10-09T12:00:00.000Z',
    pnlValue: 12.5,
    pnlPercent: 1.25,
    collectedFee: 3,
    ...overrides,
  };
}

type OpeningStep = OpenPosition[] | Error | ((owner: string) => OpenPosition[]);

function setup(
  opts: { wallets?: string[]; config?: { closeMissLimit?: number }; seed?: (db: Db) => void } = {},
) {
  const db: Db = openDb(':memory:');
  for (const w of opts.wallets ?? [A]) db.addWallet(w, null, T0.toISOString());
  opts.seed?.(db); // before the poller exists, so it seeds pendingConfirm from the db

  const openingQueue: OpeningStep[] = [];
  const historicalQueue: (ClosedPosition[] | Error)[] = [];
  const openingCalls: string[] = [];
  const historicalCalls: { owner: string; from: Date }[] = [];

  const client: LpAgentClient = {
    async getOpening(owner) {
      openingCalls.push(owner);
      const step = openingQueue.length > 1 ? openingQueue.shift()! : openingQueue[0];
      if (step === undefined) throw new Error('no opening response queued');
      if (step instanceof Error) throw step;
      return typeof step === 'function' ? step(owner) : step;
    },
    async getHistorical(owner, from) {
      historicalCalls.push({ owner, from });
      const step = historicalQueue.length > 1 ? historicalQueue.shift()! : historicalQueue[0];
      if (step === undefined) throw new Error('no historical response queued');
      if (step instanceof Error) throw step;
      return step;
    },
  };

  const sent: string[] = [];
  const state = { failNext: false };
  const notify = async (html: string) => {
    if (state.failNext) {
      state.failNext = false;
      throw new Error('telegram down');
    }
    sent.push(html);
  };

  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);

  const poller = createPoller({
    db,
    client,
    notify,
    logger: pino({ level: 'silent' }),
    config: { rpmLimit: 5, feeAlertMinUsd: 1, closeMissLimit: opts.config?.closeMissLimit ?? 3 },
    now,
  });

  return { db, poller, sent, state, clock, openingQueue, historicalQueue, openingCalls, historicalCalls };
}

describe('poller', () => {
  it('first poll baselines silently', async () => {
    const s = setup();
    s.openingQueue.push([makePosition({ tokenId: '1' }), makePosition({ tokenId: '2' })]);
    await s.poller.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('Tracking');
    expect(s.db.getWallet(A)!.baselined).toBe(true);
    expect(s.db.getPositions(A)).toHaveLength(2);
  });

  it('new position after baseline alerts opened', async () => {
    const s = setup();
    s.openingQueue.push([makePosition({ tokenId: '1' })]);
    await s.poller.tick();
    s.sent.length = 0;
    s.openingQueue.length = 0;
    s.openingQueue.push([makePosition({ tokenId: '1' }), makePosition({ tokenId: '2' })]);
    await s.poller.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('OPENED');
  });

  it('round-robins wallets', async () => {
    const s = setup({ wallets: [A, B] });
    s.openingQueue.push([]);
    await s.poller.tick();
    await s.poller.tick();
    await s.poller.tick();
    expect(s.openingCalls).toEqual([A, B, A]);
  });

  it('round-robin stays correct when wallets are removed between ticks', async () => {
    const C = '0x' + 'c'.repeat(40);
    const s = setup({ wallets: [A, B, C] });
    s.openingQueue.push([]);
    await s.poller.tick(); // A
    await s.poller.tick(); // B
    s.db.removeWallet(B);
    await s.poller.tick(); // last polled is gone -> first wallet (A)
    s.db.removeWallet(A);
    await s.poller.tick(); // C
    expect(s.openingCalls).toEqual([A, B, A, C]);
  });

  it('does nothing without wallets', async () => {
    const s = setup({ wallets: [] });
    await s.poller.tick();
    expect(s.openingCalls).toHaveLength(0);
  });

  it('missing position triggers historical confirm next tick', async () => {
    const s = setup();
    const p1 = makePosition({ tokenId: '1' });
    const p2 = makePosition({ tokenId: '2' });
    s.db.applyPollResult(A, {
      upserts: [makeRow(p1), makeRow(p2, { lastSeenAt: SEEN })],
      deletes: [],
      markBaselined: true,
    });
    s.openingQueue.push([p1]);
    s.historicalQueue.push([closedOf(p2)]);

    await s.poller.tick();
    expect(s.sent).toHaveLength(0);
    expect(s.db.getPositions(A).find((r) => r.key === 'uniswap_v3:2')!.missCount).toBe(1);
    expect(s.poller.status().pendingConfirms).toBe(1);

    await s.poller.tick();
    expect(s.openingCalls).toHaveLength(1);
    expect(s.historicalCalls).toHaveLength(1);
    expect(s.historicalCalls[0].owner).toBe(A);
    expect(s.historicalCalls[0].from.toISOString()).toBe(
      new Date(Date.parse(SEEN) - 3_600_000).toISOString(),
    );
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('CLOSED');
    expect(s.db.getPositions(A).map((r) => r.key)).toEqual(['uniswap_v3:1']);
    expect(s.poller.status().pendingConfirms).toBe(0);
  });

  it('forced close after miss limit', async () => {
    const s = setup();
    const p1 = makePosition({ tokenId: '1' });
    s.db.applyPollResult(A, { upserts: [makeRow(p1)], deletes: [], markBaselined: true });
    s.openingQueue.push([]);
    s.historicalQueue.push([]);

    for (let i = 0; i < 5; i++) {
      await s.poller.tick();
      expect(s.sent).toHaveLength(0);
    }
    await s.poller.tick(); // third confirm
    expect(s.openingCalls).toHaveLength(3);
    expect(s.historicalCalls).toHaveLength(3);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('CLOSED');
    expect(s.sent[0]).toContain('PnL: unavailable');
    expect(s.db.getPositions(A)).toHaveLength(0);
  });

  it('invalid response does not increment miss counts', async () => {
    const s = setup();
    const p1 = makePosition({ tokenId: '1' });
    s.db.applyPollResult(A, { upserts: [makeRow(p1)], deletes: [], markBaselined: true });
    s.openingQueue.push(new LpAgentError('invalid_response', 'bad shape'));
    await s.poller.tick();
    expect(s.db.getPositions(A)[0].missCount).toBe(0);
    expect(s.poller.status().pendingConfirms).toBe(0);
    expect(s.poller.status().lastError?.message).toBe('bad shape');
  });

  it('unexpected client errors are treated as api errors', async () => {
    const s = setup();
    s.openingQueue.push(new TypeError('boom'));
    await s.poller.tick();
    expect(s.poller.status().lastError?.message).toBe('boom');
    s.clock.t += 1000;
    await s.poller.tick();
    expect(s.openingCalls).toHaveLength(1);
  });

  it('backs off after api error', async () => {
    const s = setup();
    s.openingQueue.push(new LpAgentError('server', 'boom'));
    await s.poller.tick();
    expect(s.openingCalls).toHaveLength(1);

    s.clock.t = T0.getTime() + 1_000;
    await s.poller.tick();
    expect(s.openingCalls).toHaveLength(1);

    s.clock.t = T0.getTime() + 25_000;
    await s.poller.tick();
    expect(s.openingCalls).toHaveLength(2);
  });

  it('backoff doubles and is capped at 5 minutes', async () => {
    const s = setup();
    s.openingQueue.push(new LpAgentError('server', 'boom'));
    for (let i = 0; i < 8; i++) {
      await s.poller.tick();
      s.clock.t += 300_000; // always past any backoff
    }
    const before = s.openingCalls.length;
    await s.poller.tick(); // error at t; backoff must be exactly 300s
    s.clock.t += 299_000;
    await s.poller.tick();
    expect(s.openingCalls.length).toBe(before + 1);
    s.clock.t += 1_000;
    await s.poller.tick();
    expect(s.openingCalls.length).toBe(before + 2);
  });

  it('api down alert after 15 minutes, once, then recovered', async () => {
    const s = setup();
    s.openingQueue.push(new LpAgentError('server', 'boom'));
    const end = T0.getTime() + 25 * 60_000; // backoff caps at 5 min, so several error ticks land after the 15 min mark
    for (let t = T0.getTime(); t <= end; t += 10_000) {
      s.clock.t = t;
      await s.poller.tick();
    }
    const failing = s.sent.filter((m) => m.includes('failing'));
    expect(failing).toHaveLength(1);
    expect(s.poller.status().apiDown).toBe(true);

    s.openingQueue.length = 0;
    s.openingQueue.push([]);
    s.clock.t = end + 301_000;
    await s.poller.tick();
    expect(s.sent.filter((m) => m.includes('recovered'))).toHaveLength(1);
    expect(s.poller.status().apiDown).toBe(false);

    s.clock.t += 60_000;
    await s.poller.tick();
    expect(s.sent.filter((m) => m.includes('recovered'))).toHaveLength(1);
  });

  it('no recovered message when the down alert was never sent', async () => {
    const s = setup();
    s.openingQueue.push(new LpAgentError('server', 'boom'));
    await s.poller.tick();
    s.openingQueue.length = 0;
    s.openingQueue.push([]);
    s.clock.t += 60_000;
    await s.poller.tick();
    expect(s.sent.filter((m) => m.includes('recovered'))).toHaveLength(0);
  });

  it('failed down alert is retried on a later error tick', async () => {
    const s = setup();
    s.openingQueue.push(new LpAgentError('server', 'boom'));
    await s.poller.tick(); // errorSince = T0
    s.clock.t = T0.getTime() + 16 * 60_000;
    s.state.failNext = true;
    await s.poller.tick();
    expect(s.sent.filter((m) => m.includes('failing'))).toHaveLength(0);
    s.clock.t += 301_000;
    await s.poller.tick();
    expect(s.sent.filter((m) => m.includes('failing'))).toHaveLength(1);
  });

  it('telegram failure commits nothing', async () => {
    const s = setup();
    s.db.applyPollResult(A, { upserts: [], deletes: [], markBaselined: true });
    s.openingQueue.push([makePosition({ tokenId: '1' })]);
    s.state.failNext = true;
    await s.poller.tick();
    expect(s.db.getPositions(A)).toHaveLength(0);
    expect(s.poller.status().lastError).toBeNull();

    s.clock.t += 1_000; // no backoff: a notify failure is not an api error
    await s.poller.tick();
    expect(s.openingCalls).toEqual([A, A]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('OPENED');
    expect(s.db.getPositions(A)).toHaveLength(1);
  });

  it('failed baselining message leaves wallet unbaselined', async () => {
    const s = setup();
    s.openingQueue.push([makePosition({ tokenId: '1' })]);
    s.state.failNext = true;
    await s.poller.tick();
    expect(s.db.getWallet(A)!.baselined).toBe(false);
    expect(s.db.getPositions(A)).toHaveLength(0);
    await s.poller.tick();
    expect(s.sent[0]).toContain('Tracking');
    expect(s.db.getWallet(A)!.baselined).toBe(true);
  });

  it('telegram failure on a close keeps the wallet pending', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({
      seed: (db) =>
        db.applyPollResult(A, {
          upserts: [makeRow(p1, { missCount: 1, lastSeenAt: SEEN })],
          deletes: [],
          markBaselined: true,
        }),
    });
    s.historicalQueue.push([closedOf(p1)]);
    expect(s.poller.status().pendingConfirms).toBe(1); // seeded from the db
    s.state.failNext = true;
    await s.poller.tick();
    expect(s.db.getPositions(A)).toHaveLength(1);
    expect(s.poller.status().pendingConfirms).toBe(1);
    await s.poller.tick();
    expect(s.sent[0]).toContain('CLOSED');
    expect(s.db.getPositions(A)).toHaveLength(0);
    expect(s.poller.status().pendingConfirms).toBe(0);
  });

  it('a failing historical call keeps the wallet pending', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({
      seed: (db) =>
        db.applyPollResult(A, {
          upserts: [makeRow(p1, { missCount: 1, lastSeenAt: SEEN })],
          deletes: [],
          markBaselined: true,
        }),
    });
    s.historicalQueue.push(new LpAgentError('network', 'down'));
    await s.poller.tick();
    expect(s.poller.status().pendingConfirms).toBe(1);
    expect(s.poller.status().lastError?.message).toBe('down');
    expect(s.db.getPositions(A)[0].missCount).toBe(1);
  });

  it('skips commit when wallet removed mid-request', async () => {
    const s = setup();
    s.openingQueue.push((owner) => {
      s.db.removeWallet(owner);
      return [makePosition({ tokenId: '1' })];
    });
    await expect(s.poller.tick()).resolves.toBeUndefined();
    expect(s.sent).toHaveLength(0);
    expect(s.db.getWallet(A)).toBeNull();
    expect(s.db.getPositions(A)).toHaveLength(0);
  });

  it('status reports wallet count and cycle time', async () => {
    const s = setup({ wallets: [A, B] });
    const st = s.poller.status();
    expect(st.walletCount).toBe(2);
    expect(st.cycleSeconds).toBeCloseTo(24);
    expect(st.startedAt).toEqual(T0);
    expect(st.apiDown).toBe(false);
    s.db.removeWallet(B);
    expect(s.poller.status().walletCount).toBe(1);
  });

  it('start/stop: stop returns promptly and double start makes one loop', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.openingQueue.push([]);
      s.poller.start();
      s.poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.openingCalls).toHaveLength(1);
      const stopped = s.poller.stop();
      await vi.advanceTimersByTimeAsync(0);
      await stopped; // resolves without advancing 12s
      await vi.advanceTimersByTimeAsync(60_000);
      expect(s.openingCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
