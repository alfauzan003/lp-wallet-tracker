import { z } from 'zod';

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface OpenPosition {
  tokenId: string;
  protocol: string;
  pairName: string;
  pool: string;
  feeTier: number; // poolInfo.fee, e.g. 3000
  token0: TokenInfo;
  token1: TokenInfo;
  inputValue: number;
  inputNative: number;
  collectedFee: number;
  collectedFeeNative: number;
  tickLower: number;
  tickUpper: number;
  price0: number;
  price1: number;
  inRange: boolean;
  createdAt: string; // ISO
}

export interface ClosedPosition {
  tokenId: string;
  protocol: string;
  createdAt: string;
  closeAt: string;
  pnlValue: number | null;
  pnlPercent: number | null;
  collectedFee: number;
}

export function positionKey(p: { protocol: string; tokenId: string }): string {
  return `${p.protocol}:${p.tokenId}`;
}

const numeric = z.union([z.number().finite(), z.string().trim().min(1)]).transform((v, ctx) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) {
    ctx.addIssue({ code: 'custom', message: 'expected a numeric value' });
    return z.NEVER;
  }
  return n;
});

/** Number or numeric string; null/absent becomes 0. */
const numOrZero = numeric.nullish().transform((v) => v ?? 0);
/** Number or numeric string; null/absent stays null. */
const numOrNull = numeric.nullish().transform((v) => v ?? null);

const idString = z
  .union([z.string().min(1), z.number().finite()])
  .transform((v) => String(v));

const tokenInfoRaw = z
  .object({
    token_symbol: z.string().nullish(),
    token_decimals: numeric.nullish(),
    token_address: z.string().nullish(),
  })
  .nullish();

function mapToken(
  address: string,
  info: z.infer<typeof tokenInfoRaw>,
  name: string | null | undefined,
  decimals: number | null | undefined,
  side: string,
  ctx: z.RefinementCtx,
): TokenInfo {
  const symbol = info?.token_symbol ?? name;
  const dec = info?.token_decimals ?? decimals;
  if (!symbol || dec === null || dec === undefined) {
    ctx.addIssue({ code: 'custom', message: `${side}: missing symbol or decimals` });
    return z.NEVER;
  }
  return { address: address.toLowerCase(), symbol, decimals: dec };
}

const pnlRaw = z
  .object({ value: numOrNull, percent: numOrNull })
  .nullish();

const openPositionRaw = z.object({
  tokenId: idString,
  protocol: z.string().min(1),
  pairName: z.string().nullish(),
  pool: z.string().nullish(),
  poolInfo: z.object({ fee: numOrZero }).nullish(),
  token0: z.string().min(1),
  token1: z.string().min(1),
  token0Info: tokenInfoRaw,
  token1Info: tokenInfoRaw,
  tokenName0: z.string().nullish(),
  tokenName1: z.string().nullish(),
  decimal0: numeric.nullish(),
  decimal1: numeric.nullish(),
  createdAt: z.string().min(1),
  inputValue: numOrZero,
  inputNative: numOrZero,
  collectedFee: numOrZero,
  collectedFeeNative: numOrZero,
  tickLower: numOrZero,
  tickUpper: numOrZero,
  price0: numOrZero,
  price1: numOrZero,
  inRange: z.boolean().nullish(),
});

const openPositionSchema = openPositionRaw.transform((r, ctx): OpenPosition => ({
  tokenId: r.tokenId,
  protocol: r.protocol,
  pairName: r.pairName ?? '',
  pool: r.pool ?? '',
  feeTier: r.poolInfo?.fee ?? 0,
  token0: mapToken(r.token0, r.token0Info, r.tokenName0, r.decimal0, 'token0', ctx),
  token1: mapToken(r.token1, r.token1Info, r.tokenName1, r.decimal1, 'token1', ctx),
  inputValue: r.inputValue,
  inputNative: r.inputNative,
  collectedFee: r.collectedFee,
  collectedFeeNative: r.collectedFeeNative,
  tickLower: r.tickLower,
  tickUpper: r.tickUpper,
  price0: r.price0,
  price1: r.price1,
  inRange: r.inRange ?? false,
  createdAt: r.createdAt,
}));

/** One historical item; parsed per item so a bad item can be skipped. */
export const closedPositionSchema = z
  .object({
    tokenId: idString,
    protocol: z.string().min(1),
    createdAt: z.string().min(1),
    closeAt: z.string().min(1).nullish(),
    close_At: z.string().min(1).nullish(),
    pnl: pnlRaw,
    collectedFee: numOrZero,
  })
  .transform((r, ctx): ClosedPosition => {
    const closeAt = r.closeAt ?? r.close_At;
    if (!closeAt) {
      ctx.addIssue({ code: 'custom', message: 'missing closeAt' });
      return z.NEVER;
    }
    return {
      tokenId: r.tokenId,
      protocol: r.protocol,
      createdAt: r.createdAt,
      closeAt,
      pnlValue: r.pnl?.value ?? null,
      pnlPercent: r.pnl?.percent ?? null,
      collectedFee: r.collectedFee,
    };
  });

export const openingResponseSchema = z
  .object({
    status: z.literal('success'),
    data: z.array(openPositionSchema),
  })
  .transform((r) => r.data);

/** Envelope only: items are parsed one by one with `closedPositionSchema`. */
export const historicalResponseSchema = z
  .object({
    status: z.literal('success'),
    data: z.object({ data: z.array(z.unknown()) }),
  })
  .transform((r) => r.data.data);
