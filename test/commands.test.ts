import { beforeEach, describe, expect, it } from 'vitest';
import { cmdAdd, cmdList, cmdRemove, cmdStatus } from '../src/commands.js';
import { openDb, type Db } from '../src/db.js';
import type { PollerStatus } from '../src/poller.js';

const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const now = new Date('2026-01-01T12:00:00Z');

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});

function status(over: Partial<PollerStatus> = {}): PollerStatus {
  return {
    startedAt: new Date(now.getTime() - 90 * 60_000),
    walletCount: 2,
    cycleSeconds: 24,
    pendingConfirms: 1,
    lastError: null,
    lastSendError: null,
    apiDown: false,
    ...over,
  };
}

describe('cmdAdd', () => {
  it('add valid with label', () => {
    const r = cmdAdd(db, `${A} whale one`, now);
    expect(r).toBe('✅ Added whale one. Baselining…');
    expect(db.getWallet(A)?.label).toBe('whale one');
  });

  it('add valid without label', () => {
    const r = cmdAdd(db, A, now);
    expect(r).toContain('✅ Added 0xaaaa…aaaa. Baselining…');
    expect(db.getWallet(A)?.label).toBeNull();
  });

  it('add rejects bad address', () => {
    for (const args of ['', 'hello', '0x123', '0x' + 'g'.repeat(40)]) {
      expect(cmdAdd(db, args, now)).toBe('Usage: /add &lt;0x address&gt; [label]');
    }
    expect(db.listWallets()).toHaveLength(0);
  });

  it('add rejects label over 32 chars', () => {
    expect(cmdAdd(db, `${A} ${'x'.repeat(33)}`, now)).toBe('Label must be 32 characters or fewer.');
    expect(db.listWallets()).toHaveLength(0);
    expect(cmdAdd(db, `${A} ${'x'.repeat(32)}`, now)).toContain('✅ Added');
  });

  it('add rejects a label starting with 0x', () => {
    expect(cmdAdd(db, `${A} 0xfoo`, now)).toBe("Label can't start with 0x.");
    expect(cmdAdd(db, `${A} 0XFOO`, now)).toBe("Label can't start with 0x.");
    expect(db.listWallets()).toHaveLength(0);
  });

  it('add duplicate address any case', () => {
    cmdAdd(db, A, now);
    const mixed = '0x' + 'A'.repeat(40);
    expect(cmdAdd(db, mixed, now)).toBe('Already tracking 0xaaaa…aaaa.');
    expect(db.listWallets()).toHaveLength(1);
  });

  it('add duplicate label', () => {
    cmdAdd(db, `${A} Whale`, now);
    expect(cmdAdd(db, `${B} whale`, now)).toBe('Label "whale" is already used.');
    expect(db.listWallets()).toHaveLength(1);
  });

  it('add escapes label in reply', () => {
    const r = cmdAdd(db, `${A} <x>`, now);
    expect(r).toContain('&lt;x&gt;');
    expect(r).not.toContain('<x>');
  });

  it('add escapes label in duplicate-label reply', () => {
    cmdAdd(db, `${A} <x>`, now);
    const r = cmdAdd(db, `${B} <X>`, now);
    expect(r).toContain('&lt;X&gt;');
    expect(r).not.toContain('<X>');
  });
});

describe('cmdRemove', () => {
  it('remove by label', () => {
    cmdAdd(db, `${A} Whale`, now);
    expect(cmdRemove(db, 'whale')).toBe('🗑 Removed Whale.');
    expect(db.listWallets()).toHaveLength(0);
  });

  it('remove by address, including uppercase prefix and checksummed case', () => {
    cmdAdd(db, A, now);
    expect(cmdRemove(db, '0X' + 'A'.repeat(40))).toContain('🗑 Removed');
    expect(db.listWallets()).toHaveLength(0);
  });

  it('remove unknown', () => {
    expect(cmdRemove(db, 'nobody')).toBe('No wallet matches "nobody".');
  });

  it('remove escapes the arg', () => {
    expect(cmdRemove(db, '<b>')).toBe('No wallet matches "&lt;b&gt;".');
  });

  it('remove empty arg shows usage', () => {
    expect(cmdRemove(db, '  ')).toBe('Usage: /remove &lt;address or label&gt;');
  });
});

describe('cmdList', () => {
  it('list empty', () => {
    expect(cmdList(db, now)).toBe('No wallets tracked. Use /add &lt;address&gt; [label].');
  });

  it('list shows count and link', () => {
    cmdAdd(db, `${A} Whale`, now);
    db.applyPollResult(A, {
      upserts: [
        {
          key: 'v3:1',
          data: { positionKey: 'v3:1' } as never,
          feeBaselineUsd: 0,
          feeBaselineNative: 0,
          missCount: 0,
          lastSeenAt: now.toISOString(),
        },
      ],
      deletes: [],
      polledAt: new Date(now.getTime() - 5 * 60_000).toISOString(),
    });
    cmdAdd(db, B, now);
    const r = cmdList(db, now);
    expect(r.split('\n')[0]).toBe('<b>Tracked wallets (2)</b>');
    expect(r).toContain('1 open');
    expect(r).toContain('chain=ROBINHOOD');
    expect(r).toContain('checked 5m ago');
    expect(r).toContain('checked never');
  });

  it('list ago formats', () => {
    cmdAdd(db, A, now);
    const at = (ms: number) =>
      db.applyPollResult(A, { upserts: [], deletes: [], polledAt: new Date(now.getTime() - ms).toISOString() });
    at(30_000);
    expect(cmdList(db, now)).toContain('checked 30s ago');
    at(3 * 3_600_000);
    expect(cmdList(db, now)).toContain('checked 3h ago');
  });
});

describe('cmdStatus', () => {
  it('status basic', () => {
    const r = cmdStatus(status(), now);
    expect(r.split('\n')).toEqual([
      'Uptime: 1h 30m',
      'Wallets: 2 · full cycle ≈ 24s',
      'Pending close checks: 1',
      'Last API error: none',
      'Last send error: none',
    ]);
  });

  it('status shows last error', () => {
    const r = cmdStatus(
      status({ lastError: { message: 'HTTP 500 <bad>', at: new Date(now.getTime() - 2 * 60_000) }, apiDown: true }),
      now,
    );
    expect(r).toContain('Last API error: HTTP 500 &lt;bad&gt; (2m ago)');
    expect(r).toContain('ago');
    expect(r).toContain('API: ⚠️ failing');
  });

  it('status truncates long error messages before escaping', () => {
    const at = new Date(now.getTime() - 10_000);
    const r = cmdStatus(
      status({ lastError: { message: 'e'.repeat(5000), at }, lastSendError: { message: 's'.repeat(5000), at } }),
      now,
    );
    expect(r.length).toBeLessThan(1000);
    expect(r).toContain(`Last API error: ${'e'.repeat(299)}… (10s ago)`);
    expect(r).toContain(`Last send error: ${'s'.repeat(299)}… (10s ago)`);
    const escaped = cmdStatus(status({ lastError: { message: '<'.repeat(5000), at } }), now);
    expect(escaped).toContain(`Last API error: ${'&lt;'.repeat(299)}… (10s ago)`);
  });

  it('status shows last send error', () => {
    const r = cmdStatus(
      status({ lastSendError: { message: 'chat <not> found', at: new Date(now.getTime() - 10_000) } }),
      now,
    );
    expect(r).toContain('Last send error: chat &lt;not&gt; found (10s ago)');
    expect(r).not.toContain('API: ⚠️ failing');
  });
});
