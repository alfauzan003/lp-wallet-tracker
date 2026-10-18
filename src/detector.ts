import { positionKey, type ClosedPosition, type OpenPosition } from './lpagent/types.js';

export interface WalletRef {
  address: string;
  label: string | null;
}

export interface PositionRow {
  key: string;
  data: OpenPosition;
  feeBaselineUsd: number;
  feeBaselineNative: number;
  lastSeenAt: string;
}

/** A close that has been alerted and is waiting for its stats from the historical endpoint. */
export interface PendingClose {
  key: string;
  /** The position as stored when it went missing (data + fee baselines). */
  row: PositionRow;
  messageId: number;
  detectedAt: string;
  attempts: number;
  nextCheckAt: string;
}

export type AlertEvent =
  | { type: 'opened'; wallet: WalletRef; position: OpenPosition }
  | {
      type: 'fee_collected';
      wallet: WalletRef;
      position: OpenPosition;
      deltaUsd: number;
      deltaNative: number;
    }
  | { type: 'closed'; wallet: WalletRef; row: PositionRow; detectedAt: string }
  | { type: 'false_alarm'; wallet: WalletRef; position: OpenPosition; close: PendingClose };

export interface DiffResult {
  events: AlertEvent[];
  upserts: PositionRow[];
  /** Keys of pending closes that are back in the opening list. */
  restores: string[];
}

/** Close checks run at these offsets from detection; the last one is the give-up point. */
export const CLOSE_CHECK_OFFSETS_MS = [
  30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000, 3_600_000,
] as const;
export const CLOSE_GIVE_UP_MS = 3_600_000;

export function nextCheckAt(detectedAt: string, attempts: number): string {
  const offset = CLOSE_CHECK_OFFSETS_MS[Math.min(attempts, CLOSE_CHECK_OFFSETS_MS.length - 1)];
  return new Date(Date.parse(detectedAt) + offset).toISOString();
}

/**
 * Pure diff of the stored rows against a fresh "opening positions" response.
 * Never mutates its inputs. A stored row missing from the response is closed
 * right away; a pending close back in the response is a false alarm.
 */
export function diffOpening(
  wallet: WalletRef,
  rows: PositionRow[],
  pending: PendingClose[],
  fresh: OpenPosition[],
  opts: { feeAlertMinUsd: number; baselining: boolean; now: string },
): DiffResult {
  const events: AlertEvent[] = [];
  const upserts: PositionRow[] = [];
  const restores: string[] = [];
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const pendingByKey = new Map(pending.map((c) => [c.key, c]));
  const seen = new Set<string>();

  for (const p of fresh) {
    const key = positionKey(p);
    if (seen.has(key)) continue; // duplicate in a single response: first wins
    seen.add(key);

    let row = rowByKey.get(key);
    const close = row ? undefined : pendingByKey.get(key);
    if (close) {
      // The saved row stands in for the stored one, so the fee check below uses its baselines.
      row = close.row;
      restores.push(key);
      events.push({ type: 'false_alarm', wallet, position: p, close });
    }
    if (!row) {
      upserts.push({
        key,
        data: p,
        feeBaselineUsd: p.collectedFee,
        feeBaselineNative: p.collectedFeeNative,
        lastSeenAt: opts.now,
      });
      if (!opts.baselining) events.push({ type: 'opened', wallet, position: p });
      continue;
    }

    const deltaUsd = p.collectedFee - row.feeBaselineUsd;
    if (!opts.baselining && deltaUsd > 0 && deltaUsd >= opts.feeAlertMinUsd) {
      events.push({
        type: 'fee_collected',
        wallet,
        position: p,
        deltaUsd,
        deltaNative: p.collectedFeeNative - row.feeBaselineNative,
      });
      upserts.push({
        key,
        data: p,
        feeBaselineUsd: p.collectedFee,
        feeBaselineNative: p.collectedFeeNative,
        lastSeenAt: opts.now,
      });
    } else {
      // Baselines move only when an alert is emitted (or while baselining) and are never lowered.
      upserts.push({
        key,
        data: p,
        feeBaselineUsd: opts.baselining
          ? Math.max(row.feeBaselineUsd, p.collectedFee)
          : row.feeBaselineUsd,
        feeBaselineNative: opts.baselining
          ? Math.max(row.feeBaselineNative, p.collectedFeeNative)
          : row.feeBaselineNative,
        lastSeenAt: opts.now,
      });
    }
  }

  for (const row of rows) {
    if (!seen.has(row.key)) events.push({ type: 'closed', wallet, row, detectedAt: opts.now });
  }

  return { events, upserts, restores };
}

export type CloseMatch =
  | { close: PendingClose; kind: 'found'; closed: ClosedPosition }
  | { close: PendingClose; kind: 'expired' }
  | { close: PendingClose; kind: 'waiting'; attempts: number; nextCheckAt: string };

/**
 * Match due pending closes against a successful historical response. Found
 * closes carry their stats; a close still missing once `CLOSE_GIVE_UP_MS` has
 * passed since detection expires; the rest wait for their next scheduled check.
 */
export function matchCloses(due: PendingClose[], historical: ClosedPosition[], now: string): CloseMatch[] {
  const closedByKey = new Map<string, ClosedPosition>();
  for (const c of historical) {
    const key = positionKey(c);
    if (!closedByKey.has(key)) closedByKey.set(key, c);
  }

  return due.map((close): CloseMatch => {
    const closed = closedByKey.get(close.key);
    if (closed) return { close, kind: 'found', closed };
    if (Date.parse(now) - Date.parse(close.detectedAt) >= CLOSE_GIVE_UP_MS) return { close, kind: 'expired' };
    const attempts = close.attempts + 1;
    return { close, kind: 'waiting', attempts, nextCheckAt: nextCheckAt(close.detectedAt, attempts) };
  });
}
