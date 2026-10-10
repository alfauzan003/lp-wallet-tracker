import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  formatApiDown,
  formatApiRecovered,
  formatBaselined,
  formatDuration,
  formatEvent,
  pickCaTokens,
  rangePercent,
  shortAddress,
  walletLink,
  walletName,
} from '../src/format.js';
import type { WalletRef } from '../src/detector.js';
import type { TokenInfo } from '../src/lpagent/types.js';
import { makePosition } from './fixtures/make.js';

const ADDR = '0x12ab34' + '0'.repeat(30) + '9f3c';
const wallet: WalletRef = { address: ADDR, label: 'whale' };

const tok = (symbol: string, n: number, decimals = 18): TokenInfo => ({
  address: '0x' + String(n).repeat(40),
  symbol,
  decimals,
});

const TSLA = tok('TSLA', 4);
const NVDA = tok('NVDA', 5);
const USDG = tok('USDG', 6);
const USDC = tok('USDC', 7);
const WETH = tok('WETH', 8);

describe('helpers', () => {
  it('shortAddress', () => {
    expect(ADDR).toHaveLength(42);
    expect(shortAddress(ADDR)).toBe('0x12ab…9f3c');
  });

  it('escapeHtml escapes & < > "', () => {
    expect(escapeHtml('a<b>&"c')).toBe('a&lt;b&gt;&amp;&quot;c');
  });

  it('walletLink lowercases the address and escapes the href', () => {
    const link = walletLink('0xABCDEF' + '0'.repeat(30) + 'ABCD');
    expect(link).toContain('address=0xabcdef');
    expect(link).toContain('chain=ROBINHOOD');
    expect(link).toContain('&amp;chain=ROBINHOOD');
    expect(link).toContain('>0xABCD…ABCD</a>');
  });

  it('walletName falls back to the short address and escapes labels', () => {
    expect(walletName({ address: ADDR, label: null })).toBe('0x12ab…9f3c');
    expect(walletName({ address: ADDR, label: 'a<b' })).toBe('a&lt;b');
  });
});

describe('pickCaTokens', () => {
  it('WETH/USDG -> [WETH]', () => {
    expect(pickCaTokens(makePosition({ token0: WETH, token1: USDG }))).toEqual([WETH]);
  });
  it('TSLA/WETH -> [TSLA]', () => {
    expect(pickCaTokens(makePosition({ token0: TSLA, token1: WETH }))).toEqual([TSLA]);
  });
  it('USDG/TSLA -> [TSLA]', () => {
    expect(pickCaTokens(makePosition({ token0: USDG, token1: TSLA }))).toEqual([TSLA]);
  });
  it('TSLA/NVDA -> both', () => {
    expect(pickCaTokens(makePosition({ token0: TSLA, token1: NVDA }))).toEqual([TSLA, NVDA]);
  });
  it('USDC/USDG -> [token0]', () => {
    expect(pickCaTokens(makePosition({ token0: USDC, token1: USDG }))).toEqual([USDC]);
  });
});

describe('rangePercent', () => {
  const base = { tickLower: 0, tickUpper: 6932, price0: 1.5, price1: 1 };

  it('in range', () => {
    const p = makePosition({ ...base, token0: TSLA, token1: USDG });
    expect(rangePercent(p)).toEqual({ lower: -33, upper: 33 });
  });

  it('orients to base token when base is token1', () => {
    const p = makePosition({ ...base, token0: USDG, token1: TSLA });
    expect(rangePercent(p)).toEqual({ lower: -25, upper: 50 });
  });

  it('accounts for token decimals', () => {
    // token1 has 6 decimals: P(tick 0) = 10^(18-6) = 1e12
    const p = makePosition({
      tickLower: 0,
      tickUpper: 6932,
      price0: 1.5e12,
      price1: 1,
      token0: TSLA,
      token1: { ...USDG, decimals: 6 },
    });
    expect(rangePercent(p)).toEqual({ lower: -33, upper: 33 });
  });
});

describe('formatDuration', () => {
  it('days and hours', () => expect(formatDuration((3 * 24 + 4) * 3600e3)).toBe('3d 4h'));
  it('hours and minutes', () => expect(formatDuration((5 * 60 + 12) * 60e3)).toBe('5h 12m'));
  it('minutes', () => expect(formatDuration(7 * 60e3)).toBe('7m'));
  it('under a minute', () => expect(formatDuration(30e3)).toBe('0m'));
});

describe('formatEvent', () => {
  const opened = makePosition({
    tokenId: '77',
    pairName: 'TSLA/USDG',
    token0: TSLA,
    token1: USDG,
    tickLower: 0,
    tickUpper: 6932,
    price0: 1.5,
    price1: 1,
    feeTier: 3000,
    inputValue: 1234.5,
    inputNative: 0.6,
    inRange: true,
  });

  it('opened', () => {
    const out = formatEvent({ type: 'opened', wallet, position: opened });
    expect(out).toMatchInlineSnapshot(`
      "<b>🟢 OPENED · whale</b>
      TSLA/USDG · Uniswap V3 · 0.3%
      Deposited: $1,234.50 (0.6 ETH)
      Range: -33% ~ +33% · in range ✅
      Position #77 · Wallet <a href="https://app.lpagent.io/portfolio?address=0x12ab340000000000000000000000000000009f3c&amp;chain=ROBINHOOD">0x12ab…9f3c</a>
      CA TSLA: <code>0x4444444444444444444444444444444444444444</code>"
    `);
    expect(out).toContain('Range: -33% ~ +33% · in range ✅');
    expect(out).toContain(`<code>${TSLA.address}</code>`);
    expect(out).toContain('chain=ROBINHOOD');
    expect(out).toContain(`address=${ADDR.toLowerCase()}`);
    expect(out).toContain('· 0.3%');
  });

  it('opened out of range, price unavailable', () => {
    const out = formatEvent({
      type: 'opened',
      wallet,
      position: { ...opened, price1: 0, inRange: false },
    });
    expect(out).toContain('Range: n/a · out of range ⚠️');
  });

  it('fee_collected', () => {
    const out = formatEvent({
      type: 'fee_collected',
      wallet,
      position: makePosition({ collectedFee: 112.4, collectedFeeNative: 0.05 }),
      deltaUsd: 38.2,
      deltaNative: 0.01263,
    });
    expect(out).toMatchInlineSnapshot(`
      "<b>💰 FEES COLLECTED · whale</b>
      WETH/USDG · Uniswap V3
      Collected: $38.20 (0.0126 ETH)
      Total collected on this position: $112.40
      Position #1 · Wallet <a href="https://app.lpagent.io/portfolio?address=0x12ab340000000000000000000000000000009f3c&amp;chain=ROBINHOOD">0x12ab…9f3c</a>
      CA WETH: <code>0x2222222222222222222222222222222222222222</code>"
    `);
    expect(out).toContain('Collected: $38.20 (0.0126 ETH)');
    expect(out).toContain('Total collected on this position: $112.40');
  });

  const position = makePosition({ collectedFee: 99 });
  const closedAt = '2026-10-04T04:00:00.000Z';

  it('closed with pnl', () => {
    const out = formatEvent({
      type: 'closed',
      wallet,
      position,
      closed: {
        tokenId: '1',
        protocol: 'uniswap_v3',
        createdAt: '2026-10-01T00:00:00.000Z',
        closeAt: closedAt,
        pnlValue: 184.3,
        pnlPercent: 7.5,
        collectedFee: 151.1,
      },
      closedAt,
    });
    expect(out).toMatchInlineSnapshot(`
      "<b>🔴 CLOSED · whale</b>
      WETH/USDG · Uniswap V3
      Held: 3d 4h
      PnL: +$184.30 (+7.5%)
      Fees earned: $151.10
      Position #1 · Wallet <a href="https://app.lpagent.io/portfolio?address=0x12ab340000000000000000000000000000009f3c&amp;chain=ROBINHOOD">0x12ab…9f3c</a>"
    `);
    expect(out).toContain('Held: 3d 4h');
    expect(out).toContain('PnL: +$184.30 (+7.5%)');
    expect(out).toContain('Fees earned: $151.10');
    expect(out).not.toContain('CA ');
  });

  it('closed with negative pnl', () => {
    const out = formatEvent({
      type: 'closed',
      wallet,
      position,
      closed: {
        tokenId: '1',
        protocol: 'uniswap_v3',
        createdAt: '2026-10-01T00:00:00.000Z',
        closeAt: closedAt,
        pnlValue: -184.3,
        pnlPercent: -3.2,
        collectedFee: 1,
      },
      closedAt,
    });
    expect(out).toContain('PnL: -$184.30 (-3.2%)');
  });

  it('closed forced', () => {
    const out = formatEvent({ type: 'closed', wallet, position, closed: null, closedAt });
    expect(out).toContain('PnL: unavailable');
    expect(out).toContain('Held: 3d 4h');
    expect(out).toContain('Fees earned: $99.00');
  });

  it('closed with clock skew clamps held to 0m', () => {
    const out = formatEvent({
      type: 'closed',
      wallet,
      position,
      closed: null,
      closedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(out).toContain('Held: 0m');
  });

  it('escapes html in label and symbol', () => {
    const out = formatEvent({
      type: 'opened',
      wallet: { address: ADDR, label: 'a<b&c' },
      position: makePosition({ pairName: 'X<Y' }),
    });
    expect(out).toContain('a&lt;b&amp;c');
    expect(out).toContain('X&lt;Y');
    expect(out).not.toContain('<b&');
  });

  it('name falls back to short address', () => {
    const out = formatEvent({
      type: 'opened',
      wallet: { address: ADDR, label: null },
      position: opened,
    });
    expect(out.split('\n')[0]).toContain('0x12ab…9f3c');
  });
});

describe('status messages', () => {
  it('formatBaselined', () => {
    expect(formatBaselined(wallet, 1)).toBe('👀 Tracking <b>whale</b>: 1 open position');
    expect(formatBaselined(wallet, 3)).toBe('👀 Tracking <b>whale</b>: 3 open positions');
  });
  it('formatApiDown escapes the reason', () => {
    expect(formatApiDown('HTTP <500>')).toBe('⚠️ LP Agent API failing: HTTP &lt;500&gt;');
  });
  it('formatApiRecovered', () => {
    expect(formatApiRecovered()).toBe('✅ LP Agent API recovered');
  });
});
