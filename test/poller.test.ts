import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ClosedPosition, OpenPosition } from '../src/lpagent/types.js';
import { LpAgentError, type LpAgentClient } from '../src/lpagent/client.js';
import { openDb, type Db } from '../src/db.js';
import type { PositionRow } from '../src/detector.js';
import type { Notifier } from '../src/notify.js';
import { createPoller } from '../src/poller.js';
import { makePosition, makeRow } from './fixtures/make.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const T0 = new Date('2026-10-10T00:00:00.000Z');
const SEEN = '2026-10-09T00:00:00.000Z';

/** ISO time `ms` after T0. */
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

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

function baseline(db: Db, wallet: string, rows: PositionRow[]): void {
  db.applyPollResult(wallet, { upserts: rows, markBaselined: true });
}

/** Seeds an alerted close (message 100, detected at T0) the way an opening poll would leave it. */
function seedClose(
  db: Db,
  wallet: string,
  row: PositionRow,
  o: { messageId?: number; attempts?: number; nextCheckAt?: string } = {},
): void {
  baseline(db, wallet, [row]);
  const nextCheckAt = o.nextCheckAt ?? at(30_000);
  db.applyPollResult(wallet, {
    upserts: [],
    closes: [{ row, messageId: o.messageId ?? 100, detectedAt: T0.toISOString(), nextCheckAt }],
  });
  if (o.attempts) db.applyCloseResult(wallet, { updates: [{ key: row.key, attempts: o.attempts, nextCheckAt }], deletes: [] });
}

type HistoricalStep = ClosedPosition[] | Error | ((owner: string) => ClosedPosition[] | Error);
type OpeningStep = OpenPosition[] | Error | ((owner: string) => OpenPosition[]);

function setup(opts: { wallets?: string[]; seed?: (db: Db) => void } = {}) {
  const db: Db = openDb(':memory:');
  for (const w of opts.wallets ?? [A]) db.addWallet(w, null, T0.toISOString());
  opts.seed?.(db); // before the poller exists, like state left by a previous run

  const openingQueue: OpeningStep[] = [];
  const historicalQueue: HistoricalStep[] = [];
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
      const res = typeof step === 'function' ? step(owner) : step;
      if (res instanceof Error) throw res;
      return res;
    },
  };

  const sent: string[] = [];
  const edits: { id: number; html: string }[] = [];
  const state = {
    failNext: false,
    failWhen: null as ((html: string) => boolean) | null,
    editFail: false,
    editGone: false,
  };
  let nextId = 100;
  const notifier: Notifier = {
    async send(html) {
      if (state.failWhen?.(html)) throw new Error('telegram rejects message');
      if (state.failNext) {
        state.failNext = false;
        throw new Error('telegram down');
      }
      sent.push(html);
      return nextId++;
    },
    async edit(id, html) {
      if (state.editFail) throw new Error('telegram edit down');
      if (state.editGone) return 'gone';
      edits.push({ id, html });
      return 'ok';
    },
  };

  const clock = { t: T0.getTime() };
  const now = () => new Date(clock.t);

  const poller = createPoller({
    db,
    client,
    notifier,
    logger: pino({ level: 'silent' }),
    config: { rpmLimit: 5, feeAlertMinUsd: 1 },
    now,
  });

  return { db, poller, sent, edits, state, clock, openingQueue, historicalQueue, openingCalls, historicalCalls };
}

/** Wallet A tracked p1 and p2; the first poll at T0 finds p2 gone and sends CLOSED as message 100. */
async function closedSetup() {
  const s = setup();
  const p1 = makePosition({ tokenId: '1' });
  const p2 = makePosition({ tokenId: '2' });
  baseline(s.db, A, [makeRow(p1), makeRow(p2, { lastSeenAt: SEEN })]);
  s.openingQueue.push([p1]);
  await s.poller.tick();
  return { s, p1, p2 };
}

/** Runs one tick and reports what kind of request it made. */
async function tickKind(s: ReturnType<typeof setup>): Promise<'check' | 'opening' | 'none'> {
  const o = s.openingCalls.length;
  const h = s.historicalCalls.length;
  await s.poller.tick();
  return s.historicalCalls.length > h ? 'check' : s.openingCalls.length > o ? 'opening' : 'none';
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

  it('missing position sends CLOSED immediately with PnL pending', async () => {
    const { s } = await closedSetup();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('CLOSED');
    expect(s.sent[0]).toContain('PnL: pending…');
    expect(s.historicalCalls).toHaveLength(0);
    expect(s.db.getPositions(A).map((r) => r.key)).toEqual(['uniswap_v3:1']);
    expect(s.db.getCloses(A)).toMatchObject([
      { key: 'uniswap_v3:2', messageId: 100, attempts: 0, detectedAt: at(0), nextCheckAt: at(30_000) },
    ]);
    expect(s.poller.status().pendingCloses).toBe(1);
  });

  it('two positions closing in one poll get their own messages', async () => {
    const s = setup();
    const [p1, p2, p3] = ['1', '2', '3'].map((tokenId) => makePosition({ tokenId }));
    baseline(s.db, A, [makeRow(p1), makeRow(p2), makeRow(p3)]);
    s.openingQueue.push([p1]);
    await s.poller.tick();
    expect(s.sent).toHaveLength(2);
    expect(s.db.getCloses(A).map((c) => [c.key, c.messageId])).toEqual([
      ['uniswap_v3:2', 100],
      ['uniswap_v3:3', 101],
    ]);
  });

  it('a close that is not due yet leaves the tick to opening polls', async () => {
    const { s } = await closedSetup();
    expect(await tickKind(s)).toBe('opening');
    expect(s.historicalCalls).toHaveLength(0);
  });

  it('edits the CLOSED message with final stats when historical has it', async () => {
    const { s, p2 } = await closedSetup();
    s.clock.t = T0.getTime() + 30_000;
    s.historicalQueue.push([closedOf(p2)]);
    await s.poller.tick();
    expect(s.historicalCalls).toHaveLength(1);
    expect(s.historicalCalls[0].owner).toBe(A);
    expect(s.historicalCalls[0].from.toISOString()).toBe(new Date(Date.parse(SEEN) - 3_600_000).toISOString());
    expect(s.edits).toEqual([{ id: 100, html: expect.stringContaining('PnL: +$12.50') }]);
    expect(s.db.getCloses(A)).toEqual([]);
    expect(s.sent).toHaveLength(1);
    expect(s.poller.status().pendingCloses).toBe(0);
  });

  it('not yet in historical advances the schedule', async () => {
    const { s } = await closedSetup();
    s.clock.t = T0.getTime() + 30_000;
    s.historicalQueue.push([]);
    await s.poller.tick();
    expect(s.edits).toEqual([]);
    expect(s.db.getCloses(A)).toMatchObject([{ attempts: 1, nextCheckAt: at(60_000) }]);
  });

  it('gives up at 60 minutes with PnL unavailable', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({
      seed: (db) => seedClose(db, A, makeRow(p1, { lastSeenAt: SEEN }), { attempts: 7, nextCheckAt: at(3_600_000) }),
    });
    s.clock.t = T0.getTime() + 3_600_000;
    s.historicalQueue.push([]);
    await s.poller.tick();
    expect(s.edits).toEqual([{ id: 100, html: expect.stringContaining('PnL: unavailable') }]);
    expect(s.db.getCloses(A)).toEqual([]);
  });

  it('historical failure never expires a close', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({
      seed: (db) => seedClose(db, A, makeRow(p1, { lastSeenAt: SEEN }), { attempts: 7, nextCheckAt: at(3_600_000) }),
    });
    s.clock.t = T0.getTime() + 61 * 60_000;
    s.historicalQueue.push(new LpAgentError('network', 'down'));
    await s.poller.tick();
    expect(s.edits).toEqual([]);
    // attempts unchanged; the next check waits out the 24s backoff
    expect(s.db.getCloses(A)).toMatchObject([{ attempts: 7, nextCheckAt: at(61 * 60_000 + 24_000) }]);
    expect(s.poller.status().lastError?.message).toBe('down');

    s.clock.t += 24_000;
    s.historicalQueue.length = 0;
    s.historicalQueue.push([]);
    s.openingQueue.push([]);
    await s.poller.tick(); // opening poll: close checks never take two ticks in a row
    await s.poller.tick(); // first successful check past the deadline expires it
    expect(s.edits).toEqual([{ id: 100, html: expect.stringContaining('PnL: unavailable') }]);
  });

  it('deleted message drops the close', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({ seed: (db) => seedClose(db, A, makeRow(p1)) });
    s.clock.t = T0.getTime() + 30_000;
    s.state.editGone = true;
    s.historicalQueue.push([closedOf(p1)]);
    await s.poller.tick();
    expect(s.db.getCloses(A)).toEqual([]);
    expect(s.poller.status().lastSendError).toBeNull();
  });

  it('edit failure on a close check retries in 5 minutes', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({ seed: (db) => seedClose(db, A, makeRow(p1)) });
    s.clock.t = T0.getTime() + 30_000;
    s.state.editFail = true;
    s.historicalQueue.push([closedOf(p1)]);
    await s.poller.tick();
    expect(s.db.getCloses(A)).toMatchObject([{ attempts: 0, nextCheckAt: at(30_000 + 300_000) }]);
    expect(s.poller.status().lastSendError?.message).toBe('telegram edit down');
  });

  it('edit failure past 2 hours drops the close', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({
      seed: (db) => seedClose(db, A, makeRow(p1), { attempts: 7, nextCheckAt: at(3_600_000) }),
    });
    s.clock.t = T0.getTime() + 7_200_000;
    s.state.editFail = true;
    s.historicalQueue.push([closedOf(p1)]);
    await s.poller.tick();
    expect(s.db.getCloses(A)).toEqual([]);
  });

  it('reappearing position while pending edits FALSE ALARM and restores it without OPENED', async () => {
    const { s, p1, p2 } = await closedSetup();
    s.openingQueue.length = 0;
    s.openingQueue.push([p1, p2]);
    await s.poller.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.edits).toEqual([{ id: 100, html: expect.stringContaining('FALSE ALARM') }]);
    expect(s.db.getPositions(A).map((r) => r.key).sort()).toEqual(['uniswap_v3:1', 'uniswap_v3:2']);
    expect(s.db.getCloses(A)).toEqual([]);
  });

  it('false-alarm edit failure commits nothing', async () => {
    const { s, p1, p2 } = await closedSetup();
    s.openingQueue.length = 0;
    s.openingQueue.push([p1, p2]);
    s.state.editFail = true;
    await s.poller.tick();
    expect(s.db.getCloses(A)).toHaveLength(1);
    expect(s.db.getPositions(A).map((r) => r.key)).toEqual(['uniswap_v3:1']);
    expect(s.poller.status().lastSendError?.message).toBe('telegram edit down');
  });

  it('CLOSED send failure commits nothing and the next poll resends', async () => {
    const s = setup();
    const p1 = makePosition({ tokenId: '1' });
    const p2 = makePosition({ tokenId: '2' });
    baseline(s.db, A, [makeRow(p1), makeRow(p2)]);
    s.openingQueue.push([p1]);
    s.state.failNext = true;
    await s.poller.tick();
    expect(s.sent).toHaveLength(0);
    expect(s.db.getPositions(A)).toHaveLength(2);
    expect(s.db.getCloses(A)).toEqual([]);

    await s.poller.tick();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('CLOSED');
    expect(s.db.getCloses(A)).toHaveLength(1);
  });

  it('reappearing after the close is finalized alerts OPENED', async () => {
    const { s, p1, p2 } = await closedSetup();
    s.clock.t = T0.getTime() + 30_000;
    s.historicalQueue.push([closedOf(p2)]);
    await s.poller.tick(); // close check: final edit
    s.openingQueue.length = 0;
    s.openingQueue.push([p1, p2]);
    await s.poller.tick();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]).toContain('OPENED');
    expect(s.edits).toHaveLength(1);
  });

  it('close schedule survives a restart', async () => {
    const p1 = makePosition({ tokenId: '1' });
    const s = setup({ seed: (db) => seedClose(db, A, makeRow(p1, { lastSeenAt: SEEN })) });
    s.clock.t = T0.getTime() + 30_000;
    s.historicalQueue.push([]);
    expect(s.poller.status().pendingCloses).toBe(1);
    expect(await tickKind(s)).toBe('check');
  });

  it('close checks never take two ticks in a row while a wallet exists', async () => {
    const s = setup({
      wallets: [A, B],
      seed: (db) => {
        seedClose(db, A, makeRow(makePosition({ tokenId: '1' })));
        seedClose(db, B, makeRow(makePosition({ tokenId: '2' })));
      },
    });
    s.clock.t = T0.getTime() + 30_000;
    s.historicalQueue.push([]);
    s.openingQueue.push([]);
    const seq = [await tickKind(s), await tickKind(s), await tickKind(s), await tickKind(s)];
    expect(seq).toEqual(['check', 'opening', 'check', 'opening']);
    expect(s.historicalCalls.map((c) => c.owner)).toEqual([A, B]);
  });

  it("a wallet whose historical keeps failing does not block another wallet's close checks", async () => {
    const s = setup({
      wallets: [A, B],
      seed: (db) => {
        seedClose(db, A, makeRow(makePosition({ tokenId: '1' })), { nextCheckAt: at(30_000) });
        seedClose(db, B, makeRow(makePosition({ tokenId: '2' })), { nextCheckAt: at(40_000) });
      },
    });
    s.clock.t = T0.getTime() + 60_000;
    s.historicalQueue.push((owner) => (owner === A ? new LpAgentError('server', 'A historical down') : []));
    s.openingQueue.push([]);

    await s.poller.tick(); // check A: fails
    s.clock.t += 301_000; // past any backoff
    await s.poller.tick(); // opening
    s.clock.t += 301_000;
    await s.poller.tick(); // check: B, not A again
    expect(s.historicalCalls.map((c) => c.owner)).toEqual([A, B]);
    expect(s.db.getCloses(B)).toMatchObject([{ attempts: 1 }]);
  });

  it("two wallets whose historical keeps failing do not block a third wallet's close checks", async () => {
    const C = '0x' + 'c'.repeat(40);
    const s = setup({
      wallets: [A, B, C],
      seed: (db) => {
        seedClose(db, A, makeRow(makePosition({ tokenId: '1' })), { nextCheckAt: at(30_000) });
        seedClose(db, B, makeRow(makePosition({ tokenId: '2' })), { nextCheckAt: at(35_000) });
        seedClose(db, C, makeRow(makePosition({ tokenId: '3' })), { nextCheckAt: at(40_000) });
      },
    });
    s.clock.t = T0.getTime() + 60_000;
    s.historicalQueue.push((owner) => (owner === C ? [] : new LpAgentError('server', 'historical down')));
    s.openingQueue.push([]);

    for (let i = 0; i < 12; i++) {
      await s.poller.tick();
      s.clock.t += 301_000; // past any backoff
    }
    expect(s.historicalCalls.map((c) => c.owner)).toContain(C);
    expect(s.db.getCloses(C)[0]!.attempts).toBeGreaterThan(0);
  });

  it('a wallet whose historical keeps failing does not starve opening polls', async () => {
    const s = setup({
      wallets: [A, B],
      seed: (db) => {
        seedClose(db, A, makeRow(makePosition({ tokenId: '1' })));
        baseline(db, B, []);
      },
    });
    s.clock.t = T0.getTime() + 30_000;
    s.historicalQueue.push(new LpAgentError('server', 'historical down'));
    s.openingQueue.push([]);

    const seq: string[] = [];
    for (let i = 0; i < 6; i++) {
      seq.push(await tickKind(s));
      s.clock.t += 301_000; // past any backoff
    }
    expect(seq).toEqual(['check', 'opening', 'check', 'opening', 'check', 'opening']);
    expect(s.openingCalls).toContain(B);
  });

  it('invalid response closes nothing', async () => {
    const s = setup();
    baseline(s.db, A, [makeRow(makePosition({ tokenId: '1' }))]);
    s.openingQueue.push(new LpAgentError('invalid_response', 'bad shape'));
    await s.poller.tick();
    expect(s.sent).toEqual([]);
    expect(s.db.getPositions(A)).toHaveLength(1);
    expect(s.poller.status().pendingCloses).toBe(0);
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
    baseline(s.db, A, []);
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

  it('a send failure does not pin the poller to one wallet', async () => {
    const s = setup({
      wallets: [A, B],
      seed: (db) => {
        baseline(db, A, []);
        baseline(db, B, []);
      },
    });
    s.openingQueue.push((owner) => (owner === A ? [makePosition({ tokenId: '1' })] : []));
    s.state.failNext = true;

    await s.poller.tick(); // A: OPENED send fails
    expect(s.db.getPositions(A)).toHaveLength(0);
    const err = s.poller.status().lastSendError;
    expect(err?.message).toBe('telegram down');
    expect(err?.at).toEqual(T0);

    await s.poller.tick(); // B gets its turn
    await s.poller.tick(); // A retried
    expect(s.openingCalls).toEqual([A, B, A]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('OPENED');
    expect(s.db.getPositions(A)).toHaveLength(1);
    expect(s.poller.status().lastSendError).not.toBeNull(); // never cleared automatically
    expect(s.poller.status().lastError).toBeNull();
  });

  it('a permanently failing send for one wallet does not block the others', async () => {
    const s = setup({
      wallets: [A, B],
      seed: (db) => {
        baseline(db, A, []);
        baseline(db, B, []);
      },
    });
    s.state.failWhen = (html) => html.includes('OPENED');
    s.openingQueue.push(() => [makePosition({ tokenId: '1' })]);
    for (let i = 0; i < 4; i++) await s.poller.tick();
    expect(s.openingCalls).toEqual([A, B, A, B]);
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

  it('status reports wallet count, cycle time and pending closes', async () => {
    const s = setup({ wallets: [A, B] });
    const st = s.poller.status();
    expect(st.walletCount).toBe(2);
    expect(st.cycleSeconds).toBeCloseTo(24);
    expect(st.startedAt).toEqual(T0);
    expect(st.apiDown).toBe(false);
    expect(st.pendingCloses).toBe(0);
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
      expect(s.openingCalls).toHaveLength(0); // first tick waits one interval (12s at 5 rpm)
      await vi.advanceTimersByTimeAsync(11_999);
      expect(s.openingCalls).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
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

  it('stop during the initial wait makes no request', async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.openingQueue.push([]);
      s.poller.start();
      await vi.advanceTimersByTimeAsync(5_000);
      await s.poller.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(s.openingCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
