import type { z } from 'zod';
import {
  historicalResponseSchema,
  openingResponseSchema,
  type ClosedPosition,
  type OpenPosition,
} from './types.js';

export type LpAgentErrorKind = 'rate_limit' | 'server' | 'client' | 'network' | 'invalid_response';

export class LpAgentError extends Error {
  readonly kind: LpAgentErrorKind;
  readonly status?: number;

  constructor(kind: LpAgentErrorKind, message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'LpAgentError';
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export interface LpAgentClient {
  getOpening(owner: string): Promise<OpenPosition[]>;
  getHistorical(owner: string, from: Date): Promise<ClosedPosition[]>;
}

const DEFAULT_BASE_URL = 'https://api.lpagent.io/open-api/v1';
const CHAIN = 'ROBINHOOD';
const HISTORICAL_PAGE_SIZE = 100;

export function createLpAgentClient(opts: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): LpAgentClient {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function request<T>(
    path: string,
    params: Record<string, string>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set('chain', CHAIN);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res: Response;
    try {
      res = await fetchFn(url, {
        headers: { 'x-api-key': opts.apiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new LpAgentError('network', `request failed: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }

    if (res.status === 429) throw new LpAgentError('rate_limit', 'rate limited (429)', { status: 429 });
    if (res.status >= 500) throw new LpAgentError('server', `server error (${res.status})`, { status: res.status });
    if (res.status < 200 || res.status >= 300) {
      throw new LpAgentError('client', `client error (${res.status})`, { status: res.status });
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new LpAgentError('invalid_response', 'response body is not valid JSON', {
        status: res.status,
        cause: err,
      });
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new LpAgentError('invalid_response', `unexpected response shape: ${parsed.error.message}`, {
        status: res.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    getOpening: (owner) => request('/lp-positions/opening', { owner }, openingResponseSchema),
    getHistorical: (owner, from) =>
      request(
        '/lp-positions/historical',
        { owner, from_date: from.toISOString(), pageSize: String(HISTORICAL_PAGE_SIZE) },
        historicalResponseSchema,
      ),
  };
}
