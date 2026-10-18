import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PendingClose, PositionRow, WalletRef } from './detector.js';
import type { OpenPosition } from './lpagent/types.js';

export interface WalletRecord extends WalletRef {
  addedAt: string;
  baselined: boolean;
  lastPolledAt: string | null;
  openCount: number;
}

export class DuplicateError extends Error {
  readonly field: 'address' | 'label';
  constructor(field: 'address' | 'label') {
    super(`duplicate ${field}`);
    this.name = 'DuplicateError';
    this.field = field;
  }
}

export interface NewClose {
  row: PositionRow;
  messageId: number;
  detectedAt: string;
  nextCheckAt: string;
}

export interface PollResultInput {
  upserts: PositionRow[];
  /** Alerted closes: moved from positions to closes. */
  closes?: NewClose[];
  /** False alarms: their closes rows are removed (the position itself comes back via upserts). */
  restores?: string[];
  markBaselined?: boolean;
  polledAt?: string;
}

export interface CloseResultInput {
  updates: { key: string; attempts: number; nextCheckAt: string }[];
  deletes: string[];
}

export interface Db {
  addWallet(address: string, label: string | null, now: string): void;
  removeWallet(addressOrLabel: string): WalletRecord | null;
  getWallet(address: string): WalletRecord | null;
  listWallets(): WalletRecord[];
  getPositions(address: string): PositionRow[];
  applyPollResult(address: string, r: PollResultInput): void;
  getCloses(address: string): PendingClose[];
  /** Wallets with a close due at `now`, earliest due first. */
  dueCloseWallets(now: string): string[];
  countCloses(): number;
  applyCloseResult(address: string, r: CloseResultInput): void;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,
  label          TEXT UNIQUE COLLATE NOCASE,
  added_at       TEXT NOT NULL,
  baselined      INTEGER NOT NULL DEFAULT 0,
  last_polled_at TEXT
);
CREATE TABLE IF NOT EXISTS positions (
  wallet              TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  position_key        TEXT NOT NULL,
  data_json           TEXT NOT NULL,
  fee_baseline_usd    REAL NOT NULL,
  fee_baseline_native REAL NOT NULL,
  miss_count          INTEGER NOT NULL DEFAULT 0, -- unused; kept so older databases open unchanged
  last_seen_at        TEXT NOT NULL,
  PRIMARY KEY (wallet, position_key)
);
CREATE TABLE IF NOT EXISTS closes (
  wallet        TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  position_key  TEXT NOT NULL,
  row_json      TEXT NOT NULL,
  message_id    INTEGER NOT NULL,
  detected_at   TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  PRIMARY KEY (wallet, position_key)
);
`;

interface WalletDbRow {
  address: string;
  label: string | null;
  added_at: string;
  baselined: number;
  last_polled_at: string | null;
  open_count: number;
}

interface PositionDbRow {
  position_key: string;
  data_json: string;
  fee_baseline_usd: number;
  fee_baseline_native: number;
  last_seen_at: string;
}

interface CloseDbRow {
  position_key: string;
  row_json: string;
  message_id: number;
  detected_at: string;
  attempts: number;
  next_check_at: string;
}

const WALLET_SELECT = `
SELECT w.address, w.label, w.added_at, w.baselined, w.last_polled_at,
       (SELECT COUNT(*) FROM positions p WHERE p.wallet = w.address) AS open_count
FROM wallets w`;

function toRecord(r: WalletDbRow): WalletRecord {
  return {
    address: r.address,
    label: r.label,
    addedAt: r.added_at,
    baselined: r.baselined === 1,
    lastPolledAt: r.last_polled_at,
    openCount: r.open_count,
  };
}

function toPositionRow(r: PositionDbRow): PositionRow {
  return {
    key: r.position_key,
    data: JSON.parse(r.data_json) as OpenPosition,
    feeBaselineUsd: r.fee_baseline_usd,
    feeBaselineNative: r.fee_baseline_native,
    lastSeenAt: r.last_seen_at,
  };
}

function toPendingClose(r: CloseDbRow): PendingClose {
  return {
    key: r.position_key,
    row: JSON.parse(r.row_json) as PositionRow,
    messageId: r.message_id,
    detectedAt: r.detected_at,
    attempts: r.attempts,
    nextCheckAt: r.next_check_at,
  };
}

function isUniqueViolation(err: unknown): err is Error & { code: string } {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
}

export function openDb(path: string): Db {
  const memory = path === ':memory:';
  if (!memory) mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  if (!memory) db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);

  const insertWallet = db.prepare(
    'INSERT INTO wallets (address, label, added_at) VALUES (?, ?, ?)',
  );
  const selectWallet = db.prepare(`${WALLET_SELECT} WHERE w.address = ?`);
  const selectWalletByLabel = db.prepare(`${WALLET_SELECT} WHERE w.label = ? COLLATE NOCASE`);
  const selectWallets = db.prepare(`${WALLET_SELECT} ORDER BY w.added_at, w.rowid`);
  const deleteWallet = db.prepare('DELETE FROM wallets WHERE address = ?');
  const selectPositions = db.prepare(
    'SELECT position_key, data_json, fee_baseline_usd, fee_baseline_native, last_seen_at FROM positions WHERE wallet = ? ORDER BY rowid',
  );
  const upsertPosition = db.prepare(`
    INSERT INTO positions (wallet, position_key, data_json, fee_baseline_usd, fee_baseline_native, miss_count, last_seen_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT (wallet, position_key) DO UPDATE SET
      data_json = excluded.data_json,
      fee_baseline_usd = excluded.fee_baseline_usd,
      fee_baseline_native = excluded.fee_baseline_native,
      miss_count = 0,
      last_seen_at = excluded.last_seen_at`);
  const deletePosition = db.prepare('DELETE FROM positions WHERE wallet = ? AND position_key = ?');
  const markBaselined = db.prepare('UPDATE wallets SET baselined = 1 WHERE address = ?');
  const setPolledAt = db.prepare('UPDATE wallets SET last_polled_at = ? WHERE address = ?');
  const insertClose = db.prepare(`
    INSERT OR REPLACE INTO closes (wallet, position_key, row_json, message_id, detected_at, attempts, next_check_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)`);
  const deleteClose = db.prepare('DELETE FROM closes WHERE wallet = ? AND position_key = ?');
  const updateClose = db.prepare(
    'UPDATE closes SET attempts = ?, next_check_at = ? WHERE wallet = ? AND position_key = ?',
  );
  const selectCloses = db.prepare(
    'SELECT position_key, row_json, message_id, detected_at, attempts, next_check_at FROM closes WHERE wallet = ? ORDER BY rowid',
  );
  const selectDueWallets = db.prepare(`
    SELECT w.address FROM wallets w JOIN closes c ON c.wallet = w.address
    WHERE c.next_check_at <= ?
    GROUP BY w.address
    ORDER BY MIN(c.next_check_at), w.added_at, w.rowid`);
  const countClosesStmt = db.prepare('SELECT COUNT(*) AS n FROM closes');

  const getWallet = (address: string): WalletRecord | null => {
    const row = selectWallet.get(address.toLowerCase()) as WalletDbRow | undefined;
    return row ? toRecord(row) : null;
  };

  const applyTx = db.transaction((address: string, r: PollResultInput) => {
    // Safety net: wallet may have been removed while a poll was in flight.
    if (!selectWallet.get(address)) return;
    for (const row of r.upserts) {
      upsertPosition.run(
        address,
        row.key,
        JSON.stringify(row.data),
        row.feeBaselineUsd,
        row.feeBaselineNative,
        row.lastSeenAt,
      );
    }
    for (const c of r.closes ?? []) {
      deletePosition.run(address, c.row.key);
      insertClose.run(address, c.row.key, JSON.stringify(c.row), c.messageId, c.detectedAt, c.nextCheckAt);
    }
    for (const key of r.restores ?? []) deleteClose.run(address, key);
    if (r.markBaselined) markBaselined.run(address);
    if (r.polledAt !== undefined) setPolledAt.run(r.polledAt, address);
  });

  const closeTx = db.transaction((address: string, r: CloseResultInput) => {
    if (!selectWallet.get(address)) return;
    for (const u of r.updates) updateClose.run(u.attempts, u.nextCheckAt, address, u.key);
    for (const key of r.deletes) deleteClose.run(address, key);
  });

  const removeTx = db.transaction((addressOrLabel: string): WalletRecord | null => {
    const row = (
      addressOrLabel.startsWith('0x')
        ? selectWallet.get(addressOrLabel.toLowerCase())
        : selectWalletByLabel.get(addressOrLabel)
    ) as WalletDbRow | undefined;
    if (!row) return null;
    deleteWallet.run(row.address); // positions and closes removed by ON DELETE CASCADE
    return toRecord(row);
  });

  return {
    addWallet(address, label, now) {
      try {
        insertWallet.run(address.toLowerCase(), label === '' ? null : label, now);
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new DuplicateError(err.message.includes('wallets.label') ? 'label' : 'address');
        }
        throw err;
      }
    },
    removeWallet: (addressOrLabel) => removeTx(addressOrLabel),
    getWallet,
    listWallets: () => (selectWallets.all() as WalletDbRow[]).map(toRecord),
    getPositions: (address) =>
      (selectPositions.all(address.toLowerCase()) as PositionDbRow[]).map(toPositionRow),
    applyPollResult: (address, r) => applyTx(address.toLowerCase(), r),
    getCloses: (address) => (selectCloses.all(address.toLowerCase()) as CloseDbRow[]).map(toPendingClose),
    dueCloseWallets: (now) => (selectDueWallets.all(now) as { address: string }[]).map((r) => r.address),
    countCloses: () => (countClosesStmt.get() as { n: number }).n,
    applyCloseResult: (address, r) => closeTx(address.toLowerCase(), r),
    close: () => {
      db.close();
    },
  };
}
