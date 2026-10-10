import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { formatEvent, rangePercent } from '../src/format.js';
import { createLpAgentClient } from '../src/lpagent/client.js';
import { openingResponseSchema } from '../src/lpagent/types.js';
import { createTelegramNotify } from '../src/notify.js';
import { Api } from 'grammy';

const BASE_URL = 'https://api.lpagent.io/open-api/v1';
const DAY_MS = 86_400_000;

async function rawGet(apiKey: string, path: string, params: Record<string, string>): Promise<unknown> {
  const url = new URL(`${BASE_URL}${path}`);
  url.searchParams.set('chain', 'ROBINHOOD');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { 'x-api-key': apiKey, accept: 'application/json' } });
  console.log(`GET ${path} -> HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${path}: response is not JSON (HTTP ${res.status})`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const send = argv.includes('--send');
  const address = argv.find((a) => !a.startsWith('--'));
  if (!address) {
    console.error('Usage: npm run probe -- <wallet address> [--send]');
    process.exit(1);
  }

  const config = loadConfig(process.env);
  await mkdir('data', { recursive: true });

  // Opening positions: save the raw body, then parse it with the production schema.
  const rawOpening = await rawGet(config.lpagentApiKey, '/lp-positions/opening', { owner: address });
  await writeFile('data/probe-opening.json', JSON.stringify(rawOpening, null, 2));
  console.log('saved data/probe-opening.json');

  const parsed = openingResponseSchema.parse(rawOpening);
  const rawItems = (rawOpening as { data?: unknown }).data;
  const rawList: Record<string, unknown>[] = Array.isArray(rawItems) ? rawItems : [];
  console.log(`${parsed.length} open position(s)`);

  const wallet = { address, label: null };
  const notify = send
    ? createTelegramNotify(new Api(config.telegramBotToken), config.telegramOwnerId)
    : null;

  for (const [i, p] of parsed.entries()) {
    const raw = rawList[i] ?? {};
    console.log('---');
    console.log(`tokenId: ${p.tokenId}`);
    console.log(`pair: ${p.pairName}`);
    console.log(`collectedFee: ${p.collectedFee}`);
    console.log(`collectedFeeNative: ${p.collectedFeeNative}`);
    console.log(`inputValue: ${p.inputValue}`);
    console.log(`inputNative: ${p.inputNative}`);
    console.log(`priceRange (raw): ${JSON.stringify(raw.priceRange)}`);
    console.log(`rangePercent: ${JSON.stringify(rangePercent(p))}`);
    const html = formatEvent({ type: 'opened', wallet, position: p });
    console.log(html);
    if (notify) {
      await notify(html);
      console.log('sent to owner');
    }
  }

  // Historical: confirm the sort order the close-confirmation logic relies on.
  // The client's fetch is wrapped so the raw body can be saved without a second request.
  const capturingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    try {
      const body: unknown = JSON.parse(await res.clone().text());
      await writeFile('data/probe-historical.json', JSON.stringify(body, null, 2));
      console.log('saved data/probe-historical.json');
    } catch {
      console.log('could not save data/probe-historical.json (body is not JSON)');
    }
    return res;
  };
  const client = createLpAgentClient({ apiKey: config.lpagentApiKey, fetch: capturingFetch });
  const from = new Date(Date.now() - 30 * DAY_MS);
  const closed = await client.getHistorical(address, from);
  console.log('---');
  console.log(`historical (last 30 days): ${closed.length} item(s)`);
  if (closed.length > 0) {
    console.log(`first closeAt: ${closed[0].closeAt}`);
    console.log(`last closeAt: ${closed[closed.length - 1].closeAt}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
