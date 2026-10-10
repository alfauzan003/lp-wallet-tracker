import type { OpenPosition } from '../../src/lpagent/types.js';
import { positionKey } from '../../src/lpagent/types.js';
import type { PositionRow } from '../../src/detector.js';

export function makePosition(overrides: Partial<OpenPosition> = {}): OpenPosition {
  return {
    tokenId: '1',
    protocol: 'uniswap_v3',
    pairName: 'WETH/USDG',
    pool: '0x1111111111111111111111111111111111111111',
    feeTier: 3000,
    token0: {
      address: '0x2222222222222222222222222222222222222222',
      symbol: 'WETH',
      decimals: 18,
    },
    token1: {
      address: '0x3333333333333333333333333333333333333333',
      symbol: 'USDG',
      decimals: 6,
    },
    inputValue: 1000,
    inputNative: 0.5,
    collectedFee: 0,
    collectedFeeNative: 0,
    tickLower: -200000,
    tickUpper: -190000,
    price0: 2000,
    price1: 1,
    inRange: true,
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

export function makeRow(p: OpenPosition, overrides: Partial<PositionRow> = {}): PositionRow {
  return {
    key: positionKey(p),
    data: p,
    feeBaselineUsd: p.collectedFee,
    feeBaselineNative: p.collectedFeeNative,
    missCount: 0,
    lastSeenAt: '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}
