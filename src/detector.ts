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
  missCount: number;
  lastSeenAt: string;
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
  | {
      type: 'closed';
      wallet: WalletRef;
      position: OpenPosition;
      closed: ClosedPosition | null;
      closedAt: string;
    };

export interface DiffResult {
  events: AlertEvent[];
  upserts: PositionRow[];
  deletes: string[];
  hasSuspects: boolean;
}

/**
 * Pure diff of the stored rows against a fresh "opening positions" response.
 * Never mutates its inputs. `deletes` is always empty: closes are decided by
 * `confirmCloses` once the historical endpoint has been consulted.
 */
export function diffOpening(
  wallet: WalletRef,
  rows: PositionRow[],
  fresh: OpenPosition[],
  opts: { feeAlertMinUsd: number; baselining: boolean; now: string },
): DiffResult {
  const events: AlertEvent[] = [];
  const upserts: PositionRow[] = [];
  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  const seen = new Set<string>();

  for (const p of fresh) {
    const key = positionKey(p);
    if (seen.has(key)) continue; // duplicate in a single response: first wins
    seen.add(key);

    const row = rowByKey.get(key);
    if (!row) {
      upserts.push({
        key,
        data: p,
        feeBaselineUsd: p.collectedFee,
        feeBaselineNative: p.collectedFeeNative,
        missCount: 0,
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
        missCount: 0,
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
        missCount: 0,
        lastSeenAt: opts.now,
      });
    }
  }

  let hasSuspects = false;
  for (const row of rows) {
    if (seen.has(row.key)) continue;
    hasSuspects = true;
    upserts.push({ ...row, missCount: row.missCount + 1 });
  }

  return { events, upserts, deletes: [], hasSuspects };
}

/**
 * Decide which missing positions are really closed. A suspect found in the
 * historical list closes with its stats; one that has been missing for
 * `closeMissLimit` polls closes without stats; the rest stay suspects.
 */
export function confirmCloses(
  wallet: WalletRef,
  suspects: PositionRow[],
  historical: ClosedPosition[],
  opts: { closeMissLimit: number; now: string },
): { events: AlertEvent[]; deletes: string[] } {
  const events: AlertEvent[] = [];
  const deletes: string[] = [];
  const closedByKey = new Map<string, ClosedPosition>();
  for (const c of historical) {
    const key = positionKey(c);
    if (!closedByKey.has(key)) closedByKey.set(key, c);
  }

  for (const row of suspects) {
    const closed = closedByKey.get(row.key);
    if (closed) {
      events.push({
        type: 'closed',
        wallet,
        position: row.data,
        closed,
        closedAt: closed.closeAt,
      });
      deletes.push(row.key);
    } else if (row.missCount >= opts.closeMissLimit) {
      events.push({
        type: 'closed',
        wallet,
        position: row.data,
        closed: null,
        closedAt: opts.now,
      });
      deletes.push(row.key);
    }
  }

  return { events, deletes };
}
