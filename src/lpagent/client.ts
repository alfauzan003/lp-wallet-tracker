import type { z } from 'zod';
import {
  closedPositionSchema,
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

export interface SkippedItemInfo {
  endpoint: 'historical';
  index: number;
  reason: string;
}

/** First zod issue only, plus a count of the rest, so error text stays short. */
function summarizeIssues(error: z.ZodError): string {
  const [first, ...rest] = error.issues;
  if (!first) return 'invalid value';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}${rest.length > 0 ? ` (+${rest.length} more)` : ''}`;
}

export function createLpAgentClient(opts: {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Called for each historical item that fails to parse and is skipped. */
  onSkippedItem?: (info: SkippedItemInfo) => void;
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
      throw new LpAgentError('invalid_response', `unexpected response shape: ${summarizeIssues(parsed.error)}`, {
        status: res.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    getOpening: (owner) => request('/lp-positions/opening', { owner }, openingResponseSchema),
    async getHistorical(owner, from) {
      const items = await request(
        '/lp-positions/historical',
        { owner, from_date: from.toISOString(), pageSize: String(HISTORICAL_PAGE_SIZE) },
        historicalResponseSchema,
      );
      // Lenient per item: a skipped item only delays a close (the forced close still applies),
      // whereas failing the whole page would block every close for the wallet.
      const closed: ClosedPosition[] = [];
      items.forEach((item, index) => {
        const parsed = closedPositionSchema.safeParse(item);
        if (parsed.success) closed.push(parsed.data);
        else opts.onSkippedItem?.({ endpoint: 'historical', index, reason: summarizeIssues(parsed.error) });
      });
      return closed;
    },
  };
}
