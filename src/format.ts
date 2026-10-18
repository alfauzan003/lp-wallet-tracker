import type { AlertEvent, WalletRef } from './detector.js';
import type { ClosedPosition, OpenPosition, TokenInfo } from './lpagent/types.js';

const usdFmt = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const ethFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Cuts `s` to at most `max` characters, ending with "…" when cut. Apply before escaping. */
export function truncate(s: string, max = 300): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function walletLink(address: string): string {
  const url = `https://app.lpagent.io/portfolio?address=${address.toLowerCase()}&chain=ROBINHOOD`;
  return `<a href="${escapeHtml(url)}">${escapeHtml(shortAddress(address))}</a>`;
}

export function walletName(w: WalletRef): string {
  return w.label ? escapeHtml(w.label) : escapeHtml(shortAddress(w.address));
}

function quoteRank(symbol: string): number {
  switch (symbol.toUpperCase()) {
    case 'USDG':
    case 'USDC':
    case 'USDT':
      return 2;
    case 'WETH':
    case 'ETH':
      return 1;
    default:
      return 0;
  }
}

/** Which side is the "base" (CA) token; the other side is the quote. */
export function baseTokenSide(p: OpenPosition): 'token0' | 'token1' | 'both' {
  const r0 = quoteRank(p.token0.symbol);
  const r1 = quoteRank(p.token1.symbol);
  if (r0 === r1) return r0 === 0 ? 'both' : 'token0';
  return r0 < r1 ? 'token0' : 'token1';
}

export function pickCaTokens(p: OpenPosition): TokenInfo[] {
  const side = baseTokenSide(p);
  if (side === 'both') return [p.token0, p.token1];
  return [p[side]];
}

function normalizeZero(n: number): number {
  return n === 0 ? 0 : n; // turns -0 into 0
}

/**
 * Range bounds as % distance from the current price, oriented to the base
 * token priced in the quote token. Values are NaN when the current price is
 * unusable (callers should check Number.isFinite).
 */
export function rangePercent(p: OpenPosition): { lower: number; upper: number } {
  const scale = 10 ** (p.token0.decimals - p.token1.decimals);
  const price = (tick: number) => 1.0001 ** tick * scale;
  const cur = p.price0 / p.price1;
  if (!Number.isFinite(cur) || cur <= 0) return { lower: NaN, upper: NaN };

  const pl = price(p.tickLower);
  const pu = price(p.tickUpper);
  const pct = (bound: number, current: number) => normalizeZero(Math.round((bound / current - 1) * 100));

  if (baseTokenSide(p) === 'token1') {
    return { lower: pct(1 / pu, 1 / cur), upper: pct(1 / pl, 1 / cur) };
  }
  return { lower: pct(pl, cur), upper: pct(pu, cur) };
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function usd(n: number): string {
  return usdFmt.format(n);
}

function signedUsd(n: number): string {
  return `${n < 0 ? '-' : '+'}${usdFmt.format(Math.abs(n))}`;
}

function eth(n: number): string {
  return `${ethFmt.format(n)} ETH`;
}

function signedPct(n: number, digits: number): string {
  const s = Math.abs(n).toFixed(digits);
  const negative = n < 0 && Number(s) !== 0;
  return `${negative ? '-' : '+'}${s}%`;
}

function feePct(feeTier: number): string {
  return `${Number((feeTier / 10_000).toFixed(4))}%`;
}

function protocolName(protocol: string): string {
  if (protocol === 'uniswap_v3') return 'Uniswap V3';
  if (protocol === 'uniswap_v4') return 'Uniswap V4';
  return escapeHtml(protocol);
}

function caLines(p: OpenPosition): string[] {
  return pickCaTokens(p).map(
    (t) => `CA ${escapeHtml(t.symbol)}: <code>${escapeHtml(t.address)}</code>`,
  );
}

function positionLine(p: OpenPosition, w: WalletRef): string {
  return `Position #${escapeHtml(p.tokenId)} · Wallet ${walletLink(w.address)}`;
}

function rangeLine(p: OpenPosition): string {
  const { lower, upper } = rangePercent(p);
  const status = p.inRange ? 'in range ✅' : 'out of range ⚠️';
  if (!Number.isFinite(lower) || !Number.isFinite(upper)) return `Range: n/a · ${status}`;
  return `Range: ${signedPct(lower, 0)} ~ ${signedPct(upper, 0)} · ${status}`;
}

export function formatEvent(e: AlertEvent): string {
  if (e.type === 'closed') {
    return formatClosed(e.wallet, e.row.data, { kind: 'pending', detectedAt: e.detectedAt });
  }
  if (e.type === 'false_alarm') return formatClosed(e.wallet, e.position, { kind: 'false_alarm' });

  const p = e.position;
  const name = walletName(e.wallet);
  const pair = escapeHtml(p.pairName);
  const proto = protocolName(p.protocol);

  switch (e.type) {
    case 'opened':
      return [
        `<b>🟢 OPENED · ${name}</b>`,
        `${pair} · ${proto} · ${feePct(p.feeTier)}`,
        `Deposited: ${usd(p.inputValue)} (${eth(p.inputNative)})`,
        rangeLine(p),
        positionLine(p, e.wallet),
        ...caLines(p),
      ].join('\n');

    case 'fee_collected':
      return [
        `<b>💰 FEES COLLECTED · ${name}</b>`,
        `${pair} · ${proto}`,
        `Collected: ${usd(e.deltaUsd)} (${eth(e.deltaNative)})`,
        `Total collected on this position: ${usd(p.collectedFee)}`,
        positionLine(p, e.wallet),
        ...caLines(p),
      ].join('\n');
  }
}

export type CloseState =
  | { kind: 'pending'; detectedAt: string }
  | { kind: 'final'; closed: ClosedPosition }
  | { kind: 'unavailable'; detectedAt: string }
  | { kind: 'false_alarm' };

/** Every state of a close alert: the first send and each later edit of that message. */
export function formatClosed(wallet: WalletRef, p: OpenPosition, state: CloseState): string {
  const name = walletName(wallet);
  const pairLine = `${escapeHtml(p.pairName)} · ${protocolName(p.protocol)}`;

  if (state.kind === 'false_alarm') {
    return [
      `<b>⚪ FALSE ALARM · ${name}</b>`,
      pairLine,
      'Position is still open.',
      positionLine(p, wallet),
    ].join('\n');
  }

  let held: number;
  let pnl: string;
  let fees: number;
  if (state.kind === 'final') {
    const c = state.closed;
    held = Date.parse(c.closeAt) - Date.parse(c.createdAt);
    pnl =
      c.pnlValue !== null && c.pnlPercent !== null
        ? `${signedUsd(c.pnlValue)} (${signedPct(c.pnlPercent, 1)})`
        : 'unavailable';
    fees = c.collectedFee > 0 ? c.collectedFee : p.collectedFee;
  } else {
    held = Date.parse(state.detectedAt) - Date.parse(p.createdAt);
    pnl = state.kind === 'pending' ? 'pending…' : 'unavailable';
    fees = p.collectedFee;
  }

  return [
    `<b>🔴 CLOSED · ${name}</b>`,
    pairLine,
    `Held: ${formatDuration(held)}`,
    `PnL: ${pnl}`,
    `Fees earned: ${usd(fees)}`,
    positionLine(p, wallet),
  ].join('\n');
}

export function formatBaselined(w: WalletRef, count: number): string {
  return `👀 Tracking <b>${walletName(w)}</b>: ${count} open position${count === 1 ? '' : 's'}`;
}

export function formatApiDown(reason: string): string {
  return `⚠️ LP Agent API failing: ${escapeHtml(truncate(reason))}`;
}

export function formatApiRecovered(): string {
  return '✅ LP Agent API recovered';
}
