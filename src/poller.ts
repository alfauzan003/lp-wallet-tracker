import type { Logger } from 'pino';
import type { Config } from './config.js';
import { diffOpening, matchCloses, nextCheckAt, type AlertEvent } from './detector.js';
import type { CloseResultInput, Db, NewClose, WalletRecord } from './db.js';
import {
  formatApiDown,
  formatApiRecovered,
  formatBaselined,
  formatClosed,
  formatEvent,
  type CloseState,
} from './format.js';
import type { LpAgentClient } from './lpagent/client.js';
import type { ClosedPosition } from './lpagent/types.js';
import type { Notifier } from './notify.js';

export interface PollerStatus {
  startedAt: Date;
  walletCount: number;
  cycleSeconds: number;
  /** Close alerts still waiting for their stats. */
  pendingCloses: number;
  lastError: { message: string; at: Date } | null;
  /** Most recent Telegram delivery failure for an event/baseline message; never cleared automatically. */
  lastSendError: { message: string; at: Date } | null;
  apiDown: boolean;
}

export interface Poller {
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  status(): PollerStatus;
}

const BACKOFF_CAP_MS = 300_000;
const API_DOWN_AFTER_MS = 15 * 60_000;
const HISTORICAL_LOOKBACK_MS = 3_600_000;
const EDIT_RETRY_MS = 300_000;
const EDIT_GIVE_UP_MS = 7_200_000;

export function createPoller(deps: {
  db: Db;
  client: LpAgentClient;
  notifier: Notifier;
  logger: Logger;
  config: Pick<Config, 'rpmLimit' | 'feeAlertMinUsd'>;
  now?: () => Date;
}): Poller {
  const { db, client, notifier, logger, config } = deps;
  const now = deps.now ?? (() => new Date());
  const intervalMs = 60_000 / config.rpmLimit;
  const startedAt = now();

  let lastPolled: string | null = null;

  let nextAllowedAt = 0;
  let backoffMs = 0;
  let errorSince: number | null = null;
  let downSent = false;
  let lastError: { message: string; at: Date } | null = null;
  let lastSendError: { message: string; at: Date } | null = null;
  let lastTickWasCloseCheck = false;

  let running: Promise<void> | null = null;
  let stopRequested = false;
  let wake: (() => void) | null = null;

  function pickNextWallet(): WalletRecord | null {
    const wallets = db.listWallets();
    if (wallets.length === 0) return null;
    const idx = lastPolled === null ? -1 : wallets.findIndex((w) => w.address === lastPolled);
    return wallets[(idx + 1) % wallets.length];
  }

  async function onApiError(err: unknown): Promise<void> {
    const at = now();
    const message = err instanceof Error ? err.message : String(err);
    lastError = { message, at };
    backoffMs = Math.min(backoffMs ? backoffMs * 2 : intervalMs * 2, BACKOFF_CAP_MS);
    nextAllowedAt = at.getTime() + backoffMs;
    if (errorSince === null) errorSince = at.getTime();
    logger.warn({ err, backoffMs }, 'lp agent request failed');

    if (!downSent && at.getTime() - errorSince >= API_DOWN_AFTER_MS) {
      try {
        await notifier.send(formatApiDown(message));
        downSent = true;
      } catch (sendErr) {
        logger.error({ err: sendErr }, 'failed to send api-down alert');
      }
    }
  }

  async function onApiSuccess(): Promise<void> {
    backoffMs = 0;
    nextAllowedAt = 0;
    errorSince = null;
    if (downSent) {
      downSent = false;
      try {
        await notifier.send(formatApiRecovered());
      } catch (err) {
        logger.error({ err }, 'failed to send api-recovered message');
      }
    }
  }

  function recordSendError(err: unknown): void {
    lastSendError = { message: err instanceof Error ? err.message : String(err), at: now() };
  }

  /** Sends each event in order (a false alarm edits its CLOSED message) and returns the new closes. */
  async function sendAll(events: AlertEvent[]): Promise<NewClose[]> {
    const closes: NewClose[] = [];
    for (const e of events) {
      if (e.type === 'false_alarm') {
        await notifier.edit(e.close.messageId, formatEvent(e)); // 'gone' is fine: nothing left to correct
        continue;
      }
      const messageId = await notifier.send(formatEvent(e));
      if (e.type === 'closed') {
        closes.push({ row: e.row, messageId, detectedAt: e.detectedAt, nextCheckAt: nextCheckAt(e.detectedAt, 0) });
      }
    }
    return closes;
  }

  async function openingPoll(wallet: WalletRecord): Promise<void> {
    const rows = db.getPositions(wallet.address);
    const pending = db.getCloses(wallet.address);
    const baselining = !wallet.baselined;

    lastPolled = wallet.address;

    let fresh;
    try {
      fresh = await client.getOpening(wallet.address);
    } catch (err) {
      await onApiError(err);
      return;
    }
    await onApiSuccess();

    const current = db.getWallet(wallet.address);
    if (!current) {
      logger.info({ wallet: wallet.address }, 'wallet removed during poll; discarding result');
      return;
    }

    const pollTime = now().toISOString();
    const diff = diffOpening(current, rows, pending, fresh, {
      feeAlertMinUsd: config.feeAlertMinUsd,
      baselining,
      now: pollTime,
    });

    let closes: NewClose[];
    try {
      closes = await sendAll(diff.events);
      if (baselining) await notifier.send(formatBaselined(current, fresh.length));
    } catch (err) {
      recordSendError(err);
      logger.error({ err, wallet: wallet.address }, 'failed to send alert; not committing poll');
      // lastPolled stays advanced: the wallet is retried on its next round-robin turn,
      // so one permanently undeliverable message cannot starve the other wallets.
      return;
    }

    // Synchronous: the removal re-check above cannot go stale before the commit.
    db.applyPollResult(wallet.address, {
      upserts: diff.upserts,
      closes,
      restores: diff.restores,
      markBaselined: baselining,
      polledAt: pollTime,
    });
  }

  /** Checks the wallet's due closes against the historical endpoint and edits their alerts. */
  async function closeCheckPoll(address: string): Promise<void> {
    const due = db.getCloses(address).filter((c) => c.nextCheckAt <= now().toISOString());
    if (due.length === 0) return;
    const oldest = Math.min(...due.map((c) => Date.parse(c.row.lastSeenAt)));
    const from = new Date(oldest - HISTORICAL_LOOKBACK_MS);

    let historical: ClosedPosition[];
    try {
      historical = await client.getHistorical(address, from);
    } catch (err) {
      await onApiError(err);
      // Attempts stay put (a close only expires after a successful response), but the
      // checks move behind the backoff so other wallets' due closes get their turn.
      const retryAt = new Date(now().getTime() + backoffMs).toISOString();
      db.applyCloseResult(address, {
        updates: due.map((c) => ({ key: c.key, attempts: c.attempts, nextCheckAt: retryAt })),
        deletes: [],
      });
      return;
    }
    await onApiSuccess();

    const current = db.getWallet(address);
    if (!current) return;

    const at = now();
    const result: CloseResultInput = { updates: [], deletes: [] };
    for (const m of matchCloses(due, historical, at.toISOString())) {
      const { close } = m;
      if (m.kind === 'waiting') {
        result.updates.push({ key: close.key, attempts: m.attempts, nextCheckAt: m.nextCheckAt });
        continue;
      }
      const state: CloseState =
        m.kind === 'found'
          ? { kind: 'final', closed: m.closed }
          : { kind: 'unavailable', detectedAt: close.detectedAt };
      try {
        await notifier.edit(close.messageId, formatClosed(current, close.row.data, state)); // 'gone' drops it too
        result.deletes.push(close.key);
      } catch (err) {
        recordSendError(err);
        const log = { err, wallet: address, position: close.key };
        if (at.getTime() - Date.parse(close.detectedAt) >= EDIT_GIVE_UP_MS) {
          logger.error(log, 'failed to edit close alert; giving up');
          result.deletes.push(close.key);
        } else {
          logger.error(log, 'failed to edit close alert; retrying later');
          const retryAt = new Date(at.getTime() + EDIT_RETRY_MS).toISOString();
          result.updates.push({ key: close.key, attempts: close.attempts, nextCheckAt: retryAt });
        }
      }
    }

    db.applyCloseResult(address, result);
  }

  async function tick(): Promise<void> {
    if (now().getTime() < nextAllowedAt) return;

    const wallet = pickNextWallet();
    const checking = db.dueCloseWallets(now().toISOString())[0];
    // Close checks take priority, but never two ticks in a row while a wallet exists to
    // poll: otherwise a wallet whose check keeps failing would starve opening polls.
    if (checking !== undefined && !(lastTickWasCloseCheck && wallet)) {
      lastTickWasCloseCheck = true;
      await closeCheckPoll(checking);
      return;
    }
    if (!wallet) return;
    lastTickWasCloseCheck = false;
    await openingPoll(wallet);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function loop(): Promise<void> {
    while (!stopRequested) {
      // Sleep first: a restart (or crash loop) right after a request never exceeds RPM_LIMIT.
      await sleep(intervalMs);
      if (stopRequested) break;
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, 'poller tick failed');
      }
    }
  }

  return {
    tick,
    start() {
      if (running) return;
      stopRequested = false;
      running = loop().finally(() => {
        running = null;
      });
    },
    async stop() {
      stopRequested = true;
      wake?.();
      if (running) await running;
    },
    status() {
      const walletCount = db.listWallets().length;
      return {
        startedAt,
        walletCount,
        cycleSeconds: (walletCount * intervalMs) / 1000,
        pendingCloses: db.countCloses(),
        lastError,
        lastSendError,
        apiDown: errorSince !== null && now().getTime() - errorSince >= API_DOWN_AFTER_MS,
      };
    },
  };
}
