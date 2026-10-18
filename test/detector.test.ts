import { describe, expect, it } from 'vitest';
import { diffOpening, matchCloses, nextCheckAt, type WalletRef } from '../src/detector.js';
import type { ClosedPosition } from '../src/lpagent/types.js';
import { makeClose, makePosition, makeRow } from './fixtures/make.js';

const wallet: WalletRef = { address: '0xabc', label: 'test' };
const NOW = '2026-10-10T12:00:00.000Z';
const opts = { feeAlertMinUsd: 1, baselining: false, now: NOW };

function makeClosed(overrides: Partial<ClosedPosition> = {}): ClosedPosition {
  return {
    tokenId: '48213',
    protocol: 'uniswap_v3',
    createdAt: '2026-09-01T00:00:00.000Z',
    closeAt: '2026-10-10T11:00:00.000Z',
    pnlValue: 184.3,
    pnlPercent: 5,
    collectedFee: 12,
    ...overrides,
  };
}

describe('diffOpening', () => {
  it('baselining emits no events and stores all', () => {
    const fresh = [makePosition({ tokenId: '1' }), makePosition({ tokenId: '2' })];
    const r = diffOpening(wallet, [], [], fresh, { ...opts, baselining: true });
    expect(r.events.length).toBe(0);
    expect(r.upserts.length).toBe(2);
    expect(r.restores).toEqual([]);
  });

  it('new position emits opened', () => {
    const p = makePosition({ collectedFee: 3, collectedFeeNative: 0.001 });
    const r = diffOpening(wallet, [], [], [p], opts);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'opened', wallet, position: p });
    expect(r.upserts[0]!.feeBaselineUsd).toBe(p.collectedFee);
    expect(r.upserts[0]!.feeBaselineNative).toBe(p.collectedFeeNative);
  });

  it('fee increase at threshold emits fee_collected', () => {
    const old = makePosition({ collectedFee: 10, collectedFeeNative: 0.004 });
    const row = makeRow(old);
    const fresh = makePosition({ collectedFee: 11, collectedFeeNative: 0.0045 });
    const r = diffOpening(wallet, [row], [], [fresh], opts);
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev.type).toBe('fee_collected');
    if (ev.type === 'fee_collected') {
      expect(ev.deltaUsd).toBe(1);
      expect(ev.deltaNative).toBeCloseTo(0.0005);
    }
    expect(r.upserts[0]!.feeBaselineUsd).toBe(11);
    expect(r.upserts[0]!.feeBaselineNative).toBe(0.0045);
    expect(r.upserts[0]!.lastSeenAt).toBe(NOW);
  });

  it('small fee increases accumulate', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r1 = diffOpening(wallet, [row], [], [makePosition({ collectedFee: 10.6 })], opts);
    expect(r1.events).toHaveLength(0);
    expect(r1.upserts[0]!.feeBaselineUsd).toBe(10);
    expect(r1.upserts[0]!.data.collectedFee).toBe(10.6);

    const r2 = diffOpening(wallet, r1.upserts, [], [makePosition({ collectedFee: 11.2 })], opts);
    expect(r2.events).toHaveLength(1);
    const ev = r2.events[0]!;
    expect(ev.type).toBe('fee_collected');
    if (ev.type === 'fee_collected') expect(ev.deltaUsd).toBeCloseTo(1.2);
  });

  it('feeAlertMinUsd 0 with unchanged fees emits nothing', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r = diffOpening(wallet, [row], [], [makePosition({ collectedFee: 10 })], { ...opts, feeAlertMinUsd: 0 });
    expect(r.events).toHaveLength(0);
  });

  it('feeAlertMinUsd 0 alerts on any increase', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r = diffOpening(wallet, [row], [], [makePosition({ collectedFee: 10.01 })], { ...opts, feeAlertMinUsd: 0 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.type).toBe('fee_collected');
  });

  it('fee decrease does not lower baseline', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r = diffOpening(wallet, [row], [], [makePosition({ collectedFee: 0 })], opts);
    expect(r.events).toHaveLength(0);
    expect(r.upserts[0]!.feeBaselineUsd).toBe(10);
  });

  it('missing position emits closed with its row and detectedAt', () => {
    const row = makeRow(makePosition({ tokenId: '2' }));
    const r = diffOpening(wallet, [row], [], [], opts);
    expect(r.events).toEqual([{ type: 'closed', wallet, row, detectedAt: NOW }]);
    expect(r.upserts).toEqual([]);
    expect(r.restores).toEqual([]);
  });

  it('pending close back in fresh emits false_alarm and restores it, no opened', () => {
    const p = makePosition({ tokenId: '2' });
    const close = makeClose(makeRow(p, { feeBaselineUsd: 4, lastSeenAt: '2026-10-09T00:00:00.000Z' }));
    const r = diffOpening(wallet, [], [close], [p], opts);
    expect(r.events).toEqual([{ type: 'false_alarm', wallet, position: p, close }]);
    expect(r.restores).toEqual([close.key]);
    expect(r.upserts).toEqual([{ ...close.row, data: p, lastSeenAt: NOW }]);
  });

  it('false alarm uses the pending close baselines so a fee collected meanwhile alerts', () => {
    const before = makePosition({ tokenId: '2', collectedFee: 0 });
    const close = makeClose(makeRow(before));
    const after = { ...before, collectedFee: 5, collectedFeeNative: 0.002 };
    const r = diffOpening(wallet, [], [close], [after], opts);
    expect(r.events.map((e) => e.type)).toEqual(['false_alarm', 'fee_collected']);
    expect(r.upserts[0]!.feeBaselineUsd).toBe(5);
  });

  it('same tokenId on v3 and v4 are distinct positions', () => {
    const v3 = makePosition({ tokenId: '1', protocol: 'uniswap_v3' });
    const v4 = makePosition({ tokenId: '1', protocol: 'uniswap_v4' });
    const r = diffOpening(wallet, [makeRow(v3)], [], [v3, v4], opts);
    const opened = r.events.filter((e) => e.type === 'opened');
    expect(r.events).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.position.protocol).toBe('uniswap_v4');
  });

  it('does not mutate inputs', () => {
    const p = makePosition({ collectedFee: 10 });
    const row = makeRow(p);
    const rowSnap = structuredClone(row);
    const close = makeClose(makeRow(makePosition({ tokenId: '2' })));
    const closeSnap = structuredClone(close);
    const fresh = [makePosition({ collectedFee: 12 }), makePosition({ tokenId: '2', collectedFee: 3 })];
    const freshSnap = structuredClone(fresh);
    const rows = [row];
    diffOpening(wallet, rows, [close], fresh, opts);
    expect(rows).toEqual([rowSnap]);
    expect(rows[0]).toBe(row);
    expect(close).toEqual(closeSnap);
    expect(fresh).toEqual(freshSnap);
  });
});

describe('nextCheckAt', () => {
  it('follows the offsets and clamps at 60m', () => {
    const d = '2026-10-10T00:00:00.000Z';
    expect(nextCheckAt(d, 0)).toBe('2026-10-10T00:00:30.000Z');
    expect(nextCheckAt(d, 5)).toBe('2026-10-10T00:15:00.000Z');
    expect(nextCheckAt(d, 7)).toBe('2026-10-10T01:00:00.000Z');
    expect(nextCheckAt(d, 99)).toBe('2026-10-10T01:00:00.000Z');
  });
});

describe('matchCloses', () => {
  const D = '2026-10-10T00:00:00.000Z';
  const at = (ms: number) => new Date(Date.parse(D) + ms).toISOString();
  const close = (attempts: number) =>
    makeClose(makeRow(makePosition({ tokenId: '48213' })), { detectedAt: D, attempts });

  it('found in historical', () => {
    const c = close(0);
    const closed = makeClosed();
    const other = makeClosed({ protocol: 'uniswap_v4', pnlValue: 1 });
    expect(matchCloses([c], [other, closed], at(30_000))).toEqual([{ close: c, kind: 'found', closed }]);
  });

  it('same tokenId on another protocol does not match', () => {
    const c = close(0);
    const r = matchCloses([c], [makeClosed({ protocol: 'uniswap_v4' })], at(30_000));
    expect(r[0]!.kind).toBe('waiting');
  });

  it('not found advances attempts and schedule', () => {
    const c = close(2);
    expect(matchCloses([c], [], at(120_000))).toEqual([
      { close: c, kind: 'waiting', attempts: 3, nextCheckAt: at(240_000) },
    ]);
  });

  it('expired at exactly 60 minutes', () => {
    const c = close(7);
    expect(matchCloses([c], [], at(3_600_000))).toEqual([{ close: c, kind: 'expired' }]);
  });

  it('not expired at 59m59s', () => {
    const c = close(7);
    expect(matchCloses([c], [], at(3_599_000))).toEqual([
      { close: c, kind: 'waiting', attempts: 8, nextCheckAt: at(3_600_000) },
    ]);
  });
});
