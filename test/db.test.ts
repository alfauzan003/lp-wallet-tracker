import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DuplicateError, openDb } from '../src/db.js';
import { makePosition, makeRow } from './fixtures/make.js';

const ADDR = '0xABCDEF0123456789ABCDEF0123456789ABCDEF01';
const ADDR2 = '0x1111111111111111111111111111111111111111';
const NOW = '2026-10-10T00:00:00.000Z';
const D30 = '2026-10-10T00:00:30.000Z';

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

  it('applyPollResult upserts and marks baselined', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    const a = makeRow(makePosition({ tokenId: '1' }), { feeBaselineUsd: 1.5 });
    const b = makeRow(makePosition({ tokenId: '2', protocol: 'uniswap_v4' }));
    db.applyPollResult(ADDR, {
      upserts: [a, b],
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
    const a2 = { ...a, feeBaselineUsd: 3 };
    db.applyPollResult(ADDR, { upserts: [a2] });
    expect(db.getPositions(ADDR)).toEqual([a2, b]);
    expect(db.getWallet(ADDR)!.baselined).toBe(true);
    db.close();
  });

  it('applyPollResult without markBaselined/polledAt leaves them untouched', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    db.applyPollResult(ADDR, { upserts: [] });
    const w = db.getWallet(ADDR)!;
    expect(w.baselined).toBe(false);
    expect(w.lastPolledAt).toBeNull();
    db.close();
  });

  it('applyPollResult on unknown wallet is a no-op', () => {
    const db = openDb(':memory:');
    const row = makeRow(makePosition());
    expect(() =>
      db.applyPollResult(ADDR, { upserts: [row], markBaselined: true, polledAt: NOW }),
    ).not.toThrow();
    expect(db.getPositions(ADDR)).toEqual([]);
    expect(db.listWallets()).toEqual([]);
    db.close();
  });

  it('removeWallet by label cascades positions', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, 'Whale', NOW);
    db.applyPollResult(ADDR, { upserts: [makeRow(makePosition())] });
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

  it('applyPollResult moves closes out of positions', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    const row1 = makeRow(makePosition({ tokenId: '1' }));
    const row2 = makeRow(makePosition({ tokenId: '2' }), { feeBaselineUsd: 4.5 });
    db.applyPollResult(ADDR, { upserts: [row1, row2] });
    db.applyPollResult(ADDR, { upserts: [], closes: [{ row: row2, messageId: 7, detectedAt: NOW, nextCheckAt: D30 }] });
    expect(db.getPositions(ADDR).map((r) => r.key)).toEqual(['uniswap_v3:1']);
    expect(db.getCloses(ADDR)).toEqual([
      { key: row2.key, row: row2, messageId: 7, detectedAt: NOW, attempts: 0, nextCheckAt: D30 },
    ]);
    db.close();
  });

  it('applyPollResult restores move a close back', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    const row2 = makeRow(makePosition({ tokenId: '2' }));
    db.applyPollResult(ADDR, { upserts: [row2] });
    db.applyPollResult(ADDR, { upserts: [], closes: [{ row: row2, messageId: 7, detectedAt: NOW, nextCheckAt: D30 }] });
    db.applyPollResult(ADDR, { upserts: [row2], restores: [row2.key] });
    expect(db.getCloses(ADDR)).toEqual([]);
    expect(db.getPositions(ADDR)).toEqual([row2]);
    db.close();
  });

  it('applyCloseResult updates and deletes', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    const row1 = makeRow(makePosition({ tokenId: '1' }));
    const row2 = makeRow(makePosition({ tokenId: '2' }));
    db.applyPollResult(ADDR, {
      upserts: [],
      closes: [
        { row: row1, messageId: 1, detectedAt: NOW, nextCheckAt: D30 },
        { row: row2, messageId: 2, detectedAt: NOW, nextCheckAt: D30 },
      ],
    });
    db.applyCloseResult(ADDR, {
      updates: [{ key: row1.key, attempts: 3, nextCheckAt: '2026-10-10T00:04:00.000Z' }],
      deletes: [row2.key],
    });
    expect(db.getCloses(ADDR)).toEqual([
      { key: row1.key, row: row1, messageId: 1, detectedAt: NOW, attempts: 3, nextCheckAt: '2026-10-10T00:04:00.000Z' },
    ]);
    expect(() => db.applyCloseResult(ADDR2, { updates: [], deletes: [row1.key] })).not.toThrow();
    expect(db.getCloses(ADDR)).toHaveLength(1);
    db.close();
  });

  it('dueCloseWallets orders by earliest due and excludes future ones', () => {
    const db = openDb(':memory:');
    const C = '0x' + 'c'.repeat(40);
    db.addWallet(ADDR, null, NOW);
    db.addWallet(ADDR2, null, NOW);
    db.addWallet(C, null, NOW);
    const close = (w: string, tokenId: string, nextCheckAt: string) =>
      db.applyPollResult(w, {
        upserts: [],
        closes: [{ row: makeRow(makePosition({ tokenId })), messageId: 1, detectedAt: NOW, nextCheckAt }],
      });
    close(ADDR, '1', '2026-10-10T00:01:00.000Z');
    close(ADDR, '2', '2026-10-10T00:09:00.000Z');
    close(ADDR2, '3', '2026-10-10T00:00:30.000Z');
    close(C, '4', '2026-10-10T02:00:00.000Z');
    expect(db.dueCloseWallets('2026-10-10T00:05:00.000Z')).toEqual([ADDR2, ADDR.toLowerCase()]);
    expect(db.countCloses()).toBe(4);
    db.close();
  });

  it('removeWallet cascades closes', () => {
    const db = openDb(':memory:');
    db.addWallet(ADDR, null, NOW);
    db.applyPollResult(ADDR, {
      upserts: [],
      closes: [{ row: makeRow(makePosition()), messageId: 1, detectedAt: NOW, nextCheckAt: D30 }],
    });
    db.removeWallet(ADDR);
    expect(db.countCloses()).toBe(0);
    db.close();
  });

  it('legacy miss_count rows load as plain open rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lp-db-'));
    const path = join(dir, 'tracker.db');
    try {
      const db = openDb(path);
      db.addWallet(ADDR, null, NOW);
      db.applyPollResult(ADDR, { upserts: [makeRow(makePosition())] });
      db.close();
      const raw = new Database(path);
      raw.prepare('UPDATE positions SET miss_count = 2').run();
      raw.close();

      const reopened = openDb(path);
      const [row] = reopened.getPositions(ADDR);
      expect(row).toEqual(makeRow(makePosition()));
      expect('missCount' in row).toBe(false);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
