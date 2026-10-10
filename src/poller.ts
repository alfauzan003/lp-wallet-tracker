import type { Logger } from 'pino';
import type { Config } from './config.js';
import { confirmCloses, diffOpening, type AlertEvent } from './detector.js';
import type { Db, WalletRecord } from './db.js';
import { formatApiDown, formatApiRecovered, formatBaselined, formatEvent } from './format.js';
import type { LpAgentClient } from './lpagent/client.js';
import type { ClosedPosition } from './lpagent/types.js';

/** Rejects if delivery failed. */
export type Notify = (html: string) => Promise<void>;

export interface PollerStatus {
  startedAt: Date;
  walletCount: number;
  cycleSeconds: number;
  pendingConfirms: number;
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

export function createPoller(deps: {
  db: Db;
  client: LpAgentClient;
  notify: Notify;
  logger: Logger;
  config: Pick<Config, 'rpmLimit' | 'feeAlertMinUsd' | 'closeMissLimit'>;
  now?: () => Date;
}): Poller {
  const { db, client, notify, logger, config } = deps;
  const now = deps.now ?? (() => new Date());
  const intervalMs = 60_000 / config.rpmLimit;
  const startedAt = now();

  const pendingConfirm = new Set<string>(db.walletsWithSuspects());
  let lastPolled: string | null = null;

  let nextAllowedAt = 0;
  let backoffMs = 0;
  let errorSince: number | null = null;
  let downSent = false;
  let lastError: { message: string; at: Date } | null = null;
  let lastSendError: { message: string; at: Date } | null = null;
  let lastTickWasConfirm = false;

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
        await notify(formatApiDown(message));
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
        await notify(formatApiRecovered());
      } catch (err) {
        logger.error({ err }, 'failed to send api-recovered message');
      }
    }
  }

  function recordSendError(err: unknown): void {
    lastSendError = { message: err instanceof Error ? err.message : String(err), at: now() };
  }

  async function sendAll(events: AlertEvent[]): Promise<void> {
    for (const e of events) await notify(formatEvent(e));
  }

  async function openingPoll(wallet: WalletRecord): Promise<void> {
    const rows = db.getPositions(wallet.address);
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
    const diff = diffOpening(current, rows, fresh, {
      feeAlertMinUsd: config.feeAlertMinUsd,
      baselining,
      now: pollTime,
    });

    try {
      await sendAll(diff.events);
      if (baselining) await notify(formatBaselined(current, fresh.length));
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
      deletes: diff.deletes,
      markBaselined: baselining,
      polledAt: pollTime,
    });
    if (diff.hasSuspects) pendingConfirm.add(wallet.address);
  }

  /** Move a failed confirm to the back so one bad wallet cannot block the others. */
  function requeueConfirm(address: string): void {
    pendingConfirm.delete(address);
    pendingConfirm.add(address);
  }

  async function confirmPoll(address: string): Promise<void> {
    if (!db.getWallet(address)) {
      pendingConfirm.delete(address);
      return;
    }
    const suspects = db.getPositions(address).filter((r) => r.missCount > 0);
    if (suspects.length === 0) {
      pendingConfirm.delete(address);
      return;
    }
    const oldest = Math.min(...suspects.map((r) => Date.parse(r.lastSeenAt)));
    const from = new Date(oldest - HISTORICAL_LOOKBACK_MS);

    let historical: ClosedPosition[];
    let historicalFailed = false;
    try {
      historical = await client.getHistorical(address, from);
    } catch (err) {
      await onApiError(err);
      // Still force-close suspects past the miss limit. Safe: miss counts only rise
      // on successful /opening responses, never on a failed request.
      historical = [];
      historicalFailed = true;
    }
    if (!historicalFailed) await onApiSuccess();

    const current = db.getWallet(address);
    if (!current) {
      pendingConfirm.delete(address);
      return;
    }

    const result = confirmCloses(current, suspects, historical, {
      closeMissLimit: config.closeMissLimit,
      now: now().toISOString(),
    });

    try {
      await sendAll(result.events);
    } catch (err) {
      recordSendError(err);
      logger.error({ err, wallet: address }, 'failed to send alert; not committing confirm');
      requeueConfirm(address);
      return;
    }

    db.applyPollResult(address, { upserts: [], deletes: result.deletes });
    if (historicalFailed && result.deletes.length < suspects.length) requeueConfirm(address);
    else pendingConfirm.delete(address);
  }

  async function tick(): Promise<void> {
    if (now().getTime() < nextAllowedAt) return;

    const wallet = pickNextWallet();
    const confirming = pendingConfirm.values().next();
    // Confirms take priority, but never two ticks in a row while a wallet exists to
    // poll: otherwise a wallet whose confirm keeps failing would starve opening polls.
    if (!confirming.done && !(lastTickWasConfirm && wallet)) {
      lastTickWasConfirm = true;
      await confirmPoll(confirming.value);
      return;
    }
    if (!wallet) return;
    lastTickWasConfirm = false;
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
      try {
        await tick();
      } catch (err) {
        logger.error({ err }, 'poller tick failed');
      }
      if (stopRequested) break;
      await sleep(intervalMs);
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
        pendingConfirms: pendingConfirm.size,
        lastError,
        lastSendError,
        apiDown: errorSince !== null && now().getTime() - errorSince >= API_DOWN_AFTER_MS,
      };
    },
  };
}
