import { describe, expect, it } from 'vitest';
import { DuplicateError, openDb } from '../src/db.js';
import { makePosition, makeRow } from './fixtures/make.js';

const ADDR = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';
const ADDR2 = '0x1111111111111111111111111111111111111111';
const NOW = '2026-10-10T00:00:00.000Z';

describe('db', () => {
  it('addWallet lowercases and lists', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    const [w] = db.listWallets();
    expect(w.address).toBe(ADDR.toLowerCase());
    expect(w.label).toBeNull();
    expect(w.baselined).toBe(false);
    expect(w.openCount).toBe(0);
    expect(w.lastPolledAt).toBeNull();
    expect(w.addedAt).toBe(NOW);
    db.close();
  });

  it('stores empty-string label as null', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, '', NOW);
    db.addWallet(ADDR2, '', NOW);
    expect(db.getWallet(ADDR)?.label).toBeNull();
    db.close();
  });

  it('duplicate address rejected', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    try {
      db.addWallet(ADDR.toLowerCase(), 'x', NOW);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateError);
      expect((e as DuplicateError).field).toBe('address');
    }
    db.close();
  });

  it('duplicate label rejected case-insensitively', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, 'Whale', NOW);
    try {
      db.addWallet(ADDR2, 'whale', NOW);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DuplicateError);
      expect((e as DuplicateError).field).toBe('label');
    }
    expect(db.listWallets()).toHaveLength(1);
    db.close();
  });

  it('applyPollResult upserts, deletes, marks baselined', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    const a = makeRow(makePosition({ tokenId: '1' }), { feeBaselineUsd: 1.5 });
    const b = makeRow(makePosition({ tokenId: '2', protocol: 'uniswap_v4' }), { missCount: 2 });
    db.applyPollResult(ADDR, {
      upserts: [a, b],
      deletes: [],
      markBaselined: true,
      polledAt: '2026-10-10T00:01:00.000Z',
    });
    const got = db.getPositions(ADDR.toUpperCase().replace('0X', '0x'));
    expect(got).toHaveLength(2);
    expect(got).toContainEqual(a);
    expect(got).toContainEqual(b);
    const w = db.getWallet(ADDR)!;
    expect(w.baselined).toBe(true);
    expect(w.openCount).toBe(2);
    expect(w.lastPolledAt).toBe('2026-10-10T00:01:00.000Z');

    // upsert replaces existing row
    const a2 = { ...a, missCount: 1, feeBaselineUsd: 3 };
    db.applyPollResult(ADDR, { upserts: [a2], deletes: [b.key] });
    expect(db.getPositions(ADDR)).toEqual([a2]);
    expect(db.getWallet(ADDR)!.openCount).toBe(1);
    expect(db.getWallet(ADDR)!.baselined).toBe(true);
    db.close();
  });

  it('applyPollResult without markBaselined/polledAt leaves them untouched', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    db.applyPollResult(ADDR, { upserts: [], deletes: [] });
    const w = db.getWallet(ADDR)!;
    expect(w.baselined).toBe(false);
    expect(w.lastPolledAt).toBeNull();
    db.close();
  });

  it('applyPollResult on unknown wallet is a no-op', () => {
    const db = openDb(':memory:');
    const row = makeRow(makePosition());
    expect(() =>
      db.applyPollResult(ADDR, { upserts: [row], deletes: [], markBaselined: true, polledAt: NOW }),
    ).not.toThrow();
    expect(db.getPositions(ADDR)).toEqual([]);
    expect(db.listWallets()).toEqual([]);
    db.close();
  });

  it('removeWallet by label cascades positions', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, 'Whale', NOW);
    db.applyPollResult(ADDR, { upserts: [makeRow(makePosition())], deletes: [] });
    const rec = db.removeWallet('WHALE');
    expect(rec?.address).toBe(ADDR.toLowerCase());
    expect(rec?.label).toBe('Whale');
    expect(rec?.openCount).toBe(1);
    expect(db.getPositions(ADDR)).toEqual([]);
    expect(db.getWallet(ADDR)).toBeNull();
    db.close();
  });

  it('removeWallet by address (any case)', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    expect(db.removeWallet(ADDR)?.address).toBe(ADDR.toLowerCase());
    expect(db.listWallets()).toEqual([]);
    db.close();
  });

  it('removeWallet unknown returns null', () => {
    const db = openDb(':memory:');
    expect(db.removeWallet('nobody')).toBeNull();
    expect(db.removeWallet(ADDR)).toBeNull();
    db.close();
  });

  it('listWallets orders by added_at then insertion', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR2, null, '2026-10-10T00:00:02.000Z');
    db.addWallet(ADDR, null, '2026-10-10T00:00:01.000Z');
    expect(db.listWallets().map((w) => w.address)).toEqual([ADDR.toLowerCase(), ADDR2]);
    db.close();
  });

  it('walletsWithSuspects', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    db.addWallet(ADDR2, null, NOW);
    db.applyPollResult(ADDR, {
      upserts: [makeRow(makePosition({ tokenId: '1' }), { missCount: 1 })],
      deletes: [],
    });
    db.applyPollResult(ADDR2, {
      upserts: [makeRow(makePosition({ tokenId: '2' }), { missCount: 0 })],
      deletes: [],
    });
    expect(db.walletsWithSuspects()).toEqual([ADDR.toLowerCase()]);
    db.close();
  });
});
