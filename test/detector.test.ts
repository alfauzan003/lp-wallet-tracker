import { describe, expect, it } from 'vitest';
import { confirmCloses, diffOpening, type WalletRef } from '../src/detector.js';
import { positionKey, type ClosedPosition } from '../src/lpagent/types.js';
import { makePosition, makeRow } from './fixtures/make.js';

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
    const r = diffOpening(wallet, [], fresh, { ...opts, baselining: true });
    expect(r.events.length).toBe(0);
    expect(r.upserts.length).toBe(2);
    expect(r.deletes).toEqual([]);
  });

  it('new position emits opened', () => {
    const p = makePosition({ collectedFee: 3, collectedFeeNative: 0.001 });
    const r = diffOpening(wallet, [], [p], opts);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'opened', wallet, position: p });
    expect(r.upserts[0]!.feeBaselineUsd).toBe(p.collectedFee);
    expect(r.upserts[0]!.feeBaselineNative).toBe(p.collectedFeeNative);
    expect(r.upserts[0]!.missCount).toBe(0);
  });

  it('fee increase at threshold emits fee_collected', () => {
    const old = makePosition({ collectedFee: 10, collectedFeeNative: 0.004 });
    const row = makeRow(old);
    const fresh = makePosition({ collectedFee: 11, collectedFeeNative: 0.0045 });
    const r = diffOpening(wallet, [row], [fresh], opts);
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
    const r1 = diffOpening(wallet, [row], [makePosition({ collectedFee: 10.6 })], opts);
    expect(r1.events).toHaveLength(0);
    expect(r1.upserts[0]!.feeBaselineUsd).toBe(10);
    expect(r1.upserts[0]!.data.collectedFee).toBe(10.6);

    const r2 = diffOpening(wallet, r1.upserts, [makePosition({ collectedFee: 11.2 })], opts);
    expect(r2.events).toHaveLength(1);
    const ev = r2.events[0]!;
    expect(ev.type).toBe('fee_collected');
    if (ev.type === 'fee_collected') expect(ev.deltaUsd).toBeCloseTo(1.2);
  });

  it('feeAlertMinUsd 0 with unchanged fees emits nothing', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r = diffOpening(wallet, [row], [makePosition({ collectedFee: 10 })], { ...opts, feeAlertMinUsd: 0 });
    expect(r.events).toHaveLength(0);
  });

  it('feeAlertMinUsd 0 alerts on any increase', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r = diffOpening(wallet, [row], [makePosition({ collectedFee: 10.01 })], { ...opts, feeAlertMinUsd: 0 });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]!.type).toBe('fee_collected');
  });

  it('fee decrease does not lower baseline', () => {
    const row = makeRow(makePosition({ collectedFee: 10 }));
    const r = diffOpening(wallet, [row], [makePosition({ collectedFee: 0 })], opts);
    expect(r.events).toHaveLength(0);
    expect(r.upserts[0]!.feeBaselineUsd).toBe(10);
  });

  it('missing position increments missCount and flags suspects', () => {
    const p = makePosition();
    const row = makeRow(p, { lastSeenAt: '2026-10-09T00:00:00.000Z' });
    const r = diffOpening(wallet, [row], [], opts);
    expect(r.events).toHaveLength(0);
    expect(r.hasSuspects).toBe(true);
    expect(r.upserts).toHaveLength(1);
    expect(r.upserts[0]!.missCount).toBe(1);
    expect(r.upserts[0]!.lastSeenAt).toBe(row.lastSeenAt);
    expect(r.upserts[0]!.data).toBe(row.data);
  });

  it('reappearing suspect resets missCount silently', () => {
    const p = makePosition();
    const row = makeRow(p, { missCount: 2 });
    const r = diffOpening(wallet, [row], [p], opts);
    expect(r.events).toHaveLength(0);
    expect(r.upserts[0]!.missCount).toBe(0);
    expect(r.hasSuspects).toBe(false);
  });

  it('same tokenId on v3 and v4 are distinct positions', () => {
    const v3 = makePosition({ tokenId: '1', protocol: 'uniswap_v3' });
    const v4 = makePosition({ tokenId: '1', protocol: 'uniswap_v4' });
    const r = diffOpening(wallet, [makeRow(v3)], [v3, v4], opts);
    const opened = r.events.filter((e) => e.type === 'opened');
    expect(r.events).toHaveLength(1);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.position.protocol).toBe('uniswap_v4');
  });

  it('does not mutate inputs', () => {
    const p = makePosition({ collectedFee: 10 });
    const row = makeRow(p);
    const rowSnap = structuredClone(row);
    const fresh = [makePosition({ collectedFee: 12 })];
    const freshSnap = structuredClone(fresh);
    const rows = [row];
    diffOpening(wallet, rows, fresh, opts);
    expect(rows).toEqual([rowSnap]);
    expect(rows[0]).toBe(row);
    expect(fresh).toEqual(freshSnap);
  });
});

describe('confirmCloses', () => {
  const copts = { closeMissLimit: 3, now: NOW };

  it('closes suspect found in historical', () => {
    const p = makePosition({ tokenId: '48213' });
    const row = makeRow(p, { missCount: 1 });
    const closed = makeClosed();
    const r = confirmCloses(wallet, [row], [closed], copts);
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev.type).toBe('closed');
    if (ev.type === 'closed') {
      expect(ev.closed?.pnlValue).toBe(184.3);
      expect(ev.closedAt).toBe(closed.closeAt);
      expect(ev.position).toBe(row.data);
    }
    expect(r.deletes).toEqual([positionKey(p)]);
  });

  it('keeps unmatched suspect under limit', () => {
    const row = makeRow(makePosition(), { missCount: 2 });
    const r = confirmCloses(wallet, [row], [], copts);
    expect(r.events).toHaveLength(0);
    expect(r.deletes).toEqual([]);
  });

  it('forces close at limit', () => {
    const row = makeRow(makePosition(), { missCount: 3 });
    const r = confirmCloses(wallet, [row], [], copts);
    expect(r.events).toHaveLength(1);
    const ev = r.events[0]!;
    expect(ev.type).toBe('closed');
    if (ev.type === 'closed') {
      expect(ev.closed).toBeNull();
      expect(ev.closedAt).toBe(NOW);
    }
    expect(r.deletes).toEqual([row.key]);
  });
});
