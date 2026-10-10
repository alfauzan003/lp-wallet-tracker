import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createLpAgentClient, LpAgentError } from '../src/lpagent/client.js';
import { positionKey } from '../src/lpagent/types.js';

const opening = JSON.parse(readFileSync(new URL('./fixtures/opening.json', import.meta.url), 'utf8'));
const historical = JSON.parse(readFileSync(new URL('./fixtures/historical.json', import.meta.url), 'utf8'));

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function stub(body: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), headers: { ...(init?.headers as Record<string, string>) } });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, client: createLpAgentClient({ apiKey: 'k', fetch: fetchFn }) };
}

const OWNER = '0xAbC0000000000000000000000000000000000001';

describe('lp agent client', () => {
  it('getOpening sends chain, owner and api key', async () => {
    const { calls, client } = stub(opening);
    await client.getOpening(OWNER);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe('/open-api/v1/lp-positions/opening');
    expect(calls[0]!.url.searchParams.get('chain')).toBe('ROBINHOOD');
    expect(calls[0]!.url.searchParams.get('owner')).toBe(OWNER);
    expect(calls[0]!.headers['x-api-key']).toBe('k');
  });

  it('getOpening maps fixture to domain', async () => {
    const { client } = stub(opening);
    const res = await client.getOpening(OWNER);
    expect(res).toHaveLength(2);
    expect(res[0]!.tokenId).toBe('48213');
    expect(res[0]!.token0.symbol).toBe('WETH');
    expect(res[0]!.token0.decimals).toBe(18);
    expect(res[0]!.token1.decimals).toBe(6);
    expect(res[0]!.feeTier).toBe(3000);
    expect(res[0]!.token0.address).toBe('0x4200000000000000000000000000000000000006');
    expect(res[0]!.token1.address).toBe('0xabcdef0000000000000000000000000000000001');
    expect(res[0]!.collectedFee).toBe(112.4);
    expect(res[1]!.collectedFee).toBe(5.5);
    expect(res[1]!.collectedFeeNative).toBe(0);
    expect(res[1]!.inRange).toBe(false);
  });

  it('getHistorical sends from_date and pageSize', async () => {
    const { calls, client } = stub(historical);
    const from = new Date('2026-10-01T00:00:00.000Z');
    const res = await client.getHistorical(OWNER, from);
    const u = calls[0]!.url;
    expect(u.pathname).toBe('/open-api/v1/lp-positions/historical');
    expect(u.searchParams.get('from_date')).toBe(from.toISOString());
    expect(u.searchParams.get('pageSize')).toBe('100');
    expect(u.searchParams.get('chain')).toBe('ROBINHOOD');
    expect(u.searchParams.get('owner')).toBe(OWNER);
    expect(res).toHaveLength(1);
    expect(res[0]!.tokenId).toBe('48213');
    expect(res[0]!.pnlValue).toBe(184.3);
    expect(res[0]!.pnlPercent).toBe(7.5);
    expect(res[0]!.collectedFee).toBe(151.1);
    expect(res[0]!.closeAt).toBe('2026-10-09T09:15:00.000Z');
  });

  it('accepts close_At and missing pnl', async () => {
    const body = {
      status: 'success',
      data: { data: [{ tokenId: 1, protocol: 'uniswap_v4', createdAt: 'a', close_At: 'b', collectedFee: null }] },
    };
    const { client } = stub(body);
    const res = await client.getHistorical(OWNER, new Date());
    expect(res[0]).toMatchObject({ closeAt: 'b', pnlValue: null, pnlPercent: null, collectedFee: 0 });
  });

  it.each([
    [429, 'rate_limit'],
    [503, 'server'],
    [401, 'client'],
  ])('classifies %i as %s', async (status, kind) => {
    const { client } = stub({ message: 'x' }, status);
    const err = await client.getOpening(OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(LpAgentError);
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('classifies fetch rejection as network', async () => {
    const client = createLpAgentClient({
      apiKey: 'k',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    });
    const err = await client.getOpening(OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(LpAgentError);
    expect(err.kind).toBe('network');
  });

  it.each([
    [{ status: 'success' }],
    [{ status: 'success', data: null }],
    [{ status: 'error', message: 'x' }],
  ])('rejects 200 without data array: %j', async (body) => {
    const { client } = stub(body);
    const err = await client.getOpening(OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(LpAgentError);
    expect(err.kind).toBe('invalid_response');
    const { client: c2 } = stub(body);
    const err2 = await c2.getHistorical(OWNER, new Date()).catch((e) => e);
    expect(err2.kind).toBe('invalid_response');
  });

  it('rejects non-json body', async () => {
    const { client } = stub('<html>oops</html>');
    const err = await client.getOpening(OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(LpAgentError);
    expect(err.kind).toBe('invalid_response');
  });

  it('positionKey joins protocol and tokenId', () => {
    expect(positionKey({ protocol: 'uniswap_v4', tokenId: '7' })).toBe('uniswap_v4:7');
  });
});
