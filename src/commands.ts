import { DuplicateError, type Db } from './db.js';
import { escapeHtml, formatDuration, shortAddress, truncate, walletLink, walletName } from './format.js';
import type { PollerStatus } from './poller.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_LABEL = 32;

function ago(then: Date, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

export function cmdAdd(db: Db, args: string, now: Date): string {
  const trimmed = args.trim();
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  const address = m?.[1] ?? '';
  if (!ADDRESS_RE.test(address)) return 'Usage: /add &lt;0x address&gt; [label]';

  const label = (m?.[2] ?? '').trim();
  if (label.length > MAX_LABEL) return `Label must be ${MAX_LABEL} characters or fewer.`;
  // /remove treats a 0x-prefixed argument as an address, so such a label could never be removed by name.
  if (/^0x/i.test(label)) return "Label can't start with 0x.";

  try {
    db.addWallet(address, label === '' ? null : label, now.toISOString());
  } catch (err) {
    if (err instanceof DuplicateError) {
      return err.field === 'label'
        ? `Label "${escapeHtml(label)}" is already used.`
        : `Already tracking ${escapeHtml(shortAddress(address.toLowerCase()))}.`;
    }
    throw err;
  }
  return `✅ Added ${walletName({ address: address.toLowerCase(), label: label === '' ? null : label })}. Baselining…`;
}

export function cmdRemove(db: Db, args: string): string {
  let arg = args.trim();
  if (arg === '') return 'Usage: /remove &lt;address or label&gt;';
  if (/^0x/i.test(arg)) arg = arg.toLowerCase();
  const removed = db.removeWallet(arg);
  if (!removed) return `No wallet matches "${escapeHtml(arg)}".`;
  return `🗑 Removed ${walletName(removed)}.`;
}

export function cmdList(db: Db, now: Date): string {
  const wallets = db.listWallets();
  if (wallets.length === 0) return 'No wallets tracked. Use /add &lt;address&gt; [label].';
  const lines = wallets.map((w) => {
    const checked = w.lastPolledAt ? ago(new Date(w.lastPolledAt), now) : 'never';
    return `${walletName(w)} · ${walletLink(w.address)} · ${w.openCount} open · checked ${checked}`;
  });
  return [`<b>Tracked wallets (${wallets.length})</b>`, ...lines].join('\n');
}

export function cmdStatus(s: PollerStatus, now: Date): string {
  const lines = [
    `Uptime: ${formatDuration(now.getTime() - s.startedAt.getTime())}`,
    `Wallets: ${s.walletCount} · full cycle ≈ ${s.cycleSeconds}s`,
    `Pending close checks: ${s.pendingConfirms}`,
    s.lastError
      ? `Last API error: ${escapeHtml(truncate(s.lastError.message))} (${ago(s.lastError.at, now)})`
      : 'Last API error: none',
    s.lastSendError
      ? `Last send error: ${escapeHtml(truncate(s.lastSendError.message))} (${ago(s.lastSendError.at, now)})`
      : 'Last send error: none',
  ];
  if (s.apiDown) lines.push('API: ⚠️ failing');
  return lines.join('\n');
}
