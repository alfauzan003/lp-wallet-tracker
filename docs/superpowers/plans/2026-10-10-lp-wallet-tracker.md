# LP Wallet Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single-owner Telegram bot that polls the LP Agent API for tracked Robinhood Chain wallets and sends alerts when they open, collect fees on, or close Uniswap LP positions.

**Architecture:** One Node.js process runs a grammY bot (long polling) and a rate-limited round-robin poller. The poller diffs each wallet's `/lp-positions/opening` result against a SQLite snapshot using pure detector functions. It confirms closes through `/lp-positions/historical` and sends Telegram HTML alerts before committing state. systemd manages the process on the VPS.

**Tech Stack:** Node.js 22 LTS, TypeScript (ESM, `module: NodeNext`), grammY, better-sqlite3, zod, pino, Vitest, tsx (dev only).

**Spec:** `docs/superpowers/specs/2026-10-10-lp-wallet-tracker-design.md`

## Global Constraints

- Every LP Agent request sends `chain=ROBINHOOD` and the `x-api-key` header. Base URL: `https://api.lpagent.io/open-api/v1`.
- Request rate never exceeds `RPM_LIMIT` (default `5`), meaning one request per `60 / RPM_LIMIT` seconds, and each tick makes at most one request.
- A failed or invalid LP Agent response never changes stored state and never counts toward a close.
- Alerts are sent before the DB commit for that poll. If a send fails, nothing from that poll is committed.
- Every piece of text interpolated into Telegram HTML goes through `escapeHtml`.
- Defaults: `FEE_ALERT_MIN_USD=1`, `CLOSE_MISS_LIMIT=3`, `DB_PATH=./data/tracker.db`, API-down warning after 15 minutes, backoff cap 5 minutes, request timeout 10 s, Telegram send attempts 3.
- Wallet link: `https://app.lpagent.io/portfolio?address=<lowercased address>&chain=ROBINHOOD`.
- ESM throughout: relative imports end in `.js`.

**Refinements to the spec, decided here:**
1. Positions are keyed by `positionKey = "<protocol>:<tokenId>"`, because V3 and V4 token IDs can collide. The DB column is `position_key`, not `token_id`. `#<tokenId>` is still what alerts display.
2. The range % is oriented to the **base token** (the CA token) priced in the quote token. If the base token is `token1`, prices are inverted and the bounds swapped, so WETH/USDG always reads as "WETH price vs. its range" whatever the on-chain token order.
3. The fee baseline never decreases. If `collectedFee` drops (an API glitch), the baseline is left alone.
4. The bot's command logic lives in `src/commands.ts` (pure functions, testable). `src/bot.ts` only wires grammY.

## Review Focus

1. **A wallet is `/remove`d while its API request is in flight.** The poller must skip the commit (no FK error, no orphan rows) and send no alerts. Test: Task 6, `skips commit when wallet removed mid-request`.
2. **LP Agent returns 200 with a missing or non-array `data`, or `status: "error"`.** This must be `invalid_response`, never an empty position list (otherwise every position would look closed). Tests: Task 2, `rejects 200 without data array`; Task 6, `invalid response does not increment miss counts`.
3. **Labels or token symbols contain `<`, `>` or `&`.** These must be escaped in every message. Tests: Task 4, `escapes html in label and symbol`; Task 7, `add escapes label in reply`.
4. **The same tokenId under `uniswap_v3` and `uniswap_v4` in one wallet.** These are two distinct positions. Test: Task 3, `same tokenId on v3 and v4 are distinct positions`.
5. **The base token is `token1`** (e.g. token0=USDG, token1=WETH). The range must still describe the WETH price. Test: Task 4, `range orients to base token when base is token1`.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
src/
  config.ts          loadConfig(env) -> Config (zod)
  lpagent/types.ts   domain types + zod schemas + positionKey()
  lpagent/client.ts  createLpAgentClient(), LpAgentError
  detector.ts        AlertEvent, PositionRow, diffOpening(), confirmCloses()
  format.ts          escapeHtml, shortAddress, rangePercent, pickCaTokens, formatEvent, ...
  db.ts              openDb(path) -> Db
  poller.ts          createPoller() -> Poller
  notify.ts          sendWithRetry(), createTelegramNotify()
  commands.ts        cmdAdd, cmdRemove, cmdList, cmdStatus
  bot.ts             createBot()
  index.ts           wiring + shutdown
scripts/probe.ts     live API check used in Task 9
deploy/lp-tracker.service
README.md
test/
  config.test.ts, client.test.ts, detector.test.ts, format.test.ts,
  db.test.ts, poller.test.ts, notify.test.ts, commands.test.ts
  fixtures/opening.json, fixtures/historical.json, fixtures/make.ts
```

---

### Task 1: Project scaffold and config

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Config {
    telegramBotToken: string; telegramOwnerId: number; lpagentApiKey: string;
    rpmLimit: number; feeAlertMinUsd: number; closeMissLimit: number; dbPath: string;
  }
  export function loadConfig(env: Record<string, string | undefined>): Config // throws Error listing every invalid var
  ```

- [ ] **Step 1: Scaffold.** `npm init -y`, then set `"type": "module"`, `"engines": {"node": ">=22"}`, and these scripts: `build: tsc`, `start: node dist/index.js`, `dev: node --env-file=.env --import tsx src/index.ts`, `probe: node --env-file=.env --import tsx scripts/probe.ts`, `test: vitest run`, `typecheck: tsc --noEmit`. Install deps `grammy better-sqlite3 zod pino` and dev deps `typescript @types/node@22 @types/better-sqlite3 vitest tsx`. tsconfig: `target ES2022`, `module/moduleResolution NodeNext`, `strict`, `outDir dist`, `rootDir src`, `include ["src"]`. vitest config: `test.include ["test/**/*.test.ts"]`. `.gitignore`: `node_modules dist data .env`. `.env.example` lists all 7 vars from spec §4 with the defaults filled in and the required vars blank.

- [ ] **Step 2: Write failing tests** in `test/config.test.ts`:
  - `parses required vars and applies defaults`: given the 3 required vars (`TELEGRAM_OWNER_ID: "12345"`), expect `telegramOwnerId === 12345`, `rpmLimit === 5`, `feeAlertMinUsd === 1`, `closeMissLimit === 3`, `dbPath === "./data/tracker.db"`.
  - `overrides defaults`: `RPM_LIMIT: "10"`, `FEE_ALERT_MIN_USD: "2.5"` gives `10` and `2.5`.
  - `throws naming missing vars`: `{}` throws, and the message contains `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, `LPAGENT_API_KEY`.
  - `rejects non-numeric owner id`: `TELEGRAM_OWNER_ID: "abc"` throws.

- [ ] **Step 3: Run** `npm test` and expect FAIL (module not found).

- [ ] **Step 4: Implement `loadConfig`** with a zod object (`z.coerce.number().int().positive()` for the owner ID, RPM and miss limit; `z.coerce.number().nonnegative()` for the fee threshold). On failure, throw `new Error("Invalid config: " + issues.map(i => i.path.join('.')).join(', '))`.

- [ ] **Step 5: Run** `npm test && npm run typecheck` and expect PASS.

- [ ] **Step 6: Commit** `feat: scaffold project and config loader`.

---

### Task 2: LP Agent types and client

**Files:**
- Create: `src/lpagent/types.ts`, `src/lpagent/client.ts`, `test/fixtures/opening.json`, `test/fixtures/historical.json`
- Test: `test/client.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export interface TokenInfo { address: string; symbol: string; decimals: number }
  export interface OpenPosition {
    tokenId: string; protocol: string; pairName: string; pool: string; feeTier: number; // poolInfo.fee, e.g. 3000
    token0: TokenInfo; token1: TokenInfo;
    inputValue: number; inputNative: number; collectedFee: number; collectedFeeNative: number;
    tickLower: number; tickUpper: number; price0: number; price1: number; inRange: boolean;
    createdAt: string; // ISO
  }
  export interface ClosedPosition {
    tokenId: string; protocol: string; createdAt: string; closeAt: string;
    pnlValue: number | null; pnlPercent: number | null; collectedFee: number;
  }
  export function positionKey(p: { protocol: string; tokenId: string }): string // `${protocol}:${tokenId}`
  export const openingResponseSchema, historicalResponseSchema // zod, output the types above
  ```
- Produces (`client.ts`):
  ```ts
  export type LpAgentErrorKind = 'rate_limit' | 'server' | 'client' | 'network' | 'invalid_response';
  export class LpAgentError extends Error { kind: LpAgentErrorKind; status?: number }
  export interface LpAgentClient {
    getOpening(owner: string): Promise<OpenPosition[]>;
    getHistorical(owner: string, from: Date): Promise<ClosedPosition[]>;
  }
  export function createLpAgentClient(opts: { apiKey: string; baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number }): LpAgentClient
  ```

**Field mapping (raw API → domain):** `tokenId` (string or number → string), `token0Info.token_symbol ?? tokenName0` → `symbol`, `token0Info.token_decimals ?? decimal0` → `decimals`, `token0` → `address` (lowercased), and the same for token1. `poolInfo.fee` → `feeTier`. `pnl.value` / `pnl.percent` → `pnlValue` / `pnlPercent` (null if absent). `closeAt ?? close_At` → `closeAt`. Numeric fields accept number or numeric string. A null or absent numeric field becomes `0`, except `pnl*`, which becomes `null`. Envelopes: opening is `{ status: "success", data: [...] }`. Historical is `{ status: "success", data: { data: [...] } }`. Unknown extra fields are allowed.

- [ ] **Step 1: Write fixtures.** `opening.json` has a success envelope with 2 positions on `uniswap_v3` that use the documented field names (spec §2): one WETH/USDG (token0 WETH, 18 decimals; token1 USDG, 6 decimals; `poolInfo.fee: 3000`; `collectedFee: 112.4`; `tokenId: 48213` as a **number**) and one TSLA/USDG with `collectedFee` as the string `"5.5"`. `historical.json` has one closed position with `tokenId: "48213"`, `protocol: "uniswap_v3"`, `closeAt`, `pnl: {value: 184.3, percent: 7.5}` and `collectedFee: 151.1`.

- [ ] **Step 2: Write failing tests** in `test/client.test.ts`, using a stub `fetch` that records the URL and headers and returns `new Response(JSON.stringify(body), {status})`:
  - `getOpening sends chain, owner and api key`: the URL path is `/open-api/v1/lp-positions/opening`, the params are `chain=ROBINHOOD` and `owner=0xabc…`, and the header is `x-api-key: k`.
  - `getOpening maps fixture to domain`: 2 positions; the first has `tokenId === "48213"`, `token0.symbol === "WETH"`, `token0.decimals === 18`, `feeTier === 3000`; the second has `collectedFee === 5.5`.
  - `getHistorical sends from_date and pageSize`: `from_date === from.toISOString()`, `pageSize=100`, `chain=ROBINHOOD`; it maps `pnlValue === 184.3` and `collectedFee === 151.1`.
  - `classifies 429 as rate_limit`, `classifies 503 as server`, `classifies 401 as client`, and `classifies fetch rejection as network` (each rejects with `LpAgentError` with the matching `kind`).
  - `rejects 200 without data array`: bodies `{status:"success"}`, `{status:"success", data: null}` and `{status:"error", message:"x"}` each reject with kind `invalid_response`.
  - `rejects non-json body`: returns `invalid_response`.
  - `positionKey joins protocol and tokenId`: `positionKey({protocol:'uniswap_v4', tokenId:'7'}) === 'uniswap_v4:7'`.

- [ ] **Step 3: Run** `npm test -- client` and expect FAIL.

- [ ] **Step 4: Implement** the schemas in `types.ts` and the client in `client.ts`. Use `AbortSignal.timeout(timeoutMs ?? 10_000)`, and require `status === "success"` in the envelope.

- [ ] **Step 5: Run** `npm test -- client` and expect PASS.

- [ ] **Step 6: Commit** `feat: add LP Agent client with response validation`.

---

### Task 3: Detector

**Files:**
- Create: `src/detector.ts`, `test/fixtures/make.ts`
- Test: `test/detector.test.ts`

**Interfaces:**
- Consumes: `OpenPosition`, `ClosedPosition`, `positionKey` (Task 2).
- Produces:
  ```ts
  export interface WalletRef { address: string; label: string | null }
  export interface PositionRow {
    key: string; data: OpenPosition; feeBaselineUsd: number; feeBaselineNative: number;
    missCount: number; lastSeenAt: string;
  }
  export type AlertEvent =
    | { type: 'opened'; wallet: WalletRef; position: OpenPosition }
    | { type: 'fee_collected'; wallet: WalletRef; position: OpenPosition; deltaUsd: number; deltaNative: number }
    | { type: 'closed'; wallet: WalletRef; position: OpenPosition; closed: ClosedPosition | null; closedAt: string };
  export interface DiffResult { events: AlertEvent[]; upserts: PositionRow[]; deletes: string[]; hasSuspects: boolean }
  export function diffOpening(wallet: WalletRef, rows: PositionRow[], fresh: OpenPosition[],
    opts: { feeAlertMinUsd: number; baselining: boolean; now: string }): DiffResult
  export function confirmCloses(wallet: WalletRef, suspects: PositionRow[], historical: ClosedPosition[],
    opts: { closeMissLimit: number; now: string }): { events: AlertEvent[]; deletes: string[] }
  ```
- `test/fixtures/make.ts` exports `makePosition(overrides?: Partial<OpenPosition>): OpenPosition` (WETH/USDG v3 defaults, `tokenId "1"`, `collectedFee 0`) and `makeRow(p: OpenPosition, overrides?: Partial<PositionRow>): PositionRow`. Tasks 4, 5 and 6 reuse both.

**Rules** (spec §5.3–5.4 plus refinement 3): new key → `opened` and an upsert with baseline = current fees and `missCount 0`. Present key → upsert with fresh `data`, `lastSeenAt = now`, `missCount 0`. If `collectedFee − feeBaselineUsd ≥ feeAlertMinUsd`, also emit `fee_collected` with the deltas and move both baselines to the current values; otherwise keep the baselines (never lower them). Missing key → upsert with `missCount + 1` (data and `lastSeenAt` unchanged) and `hasSuspects = true`. When `baselining` is true, there are no events and every fresh position is upserted. `deletes` is always empty from `diffOpening`. `confirmCloses`: a suspect whose key matches `positionKey(historical item)` → `closed` with that `ClosedPosition` and `closedAt = closeAt`, then deleted. Unmatched with `missCount ≥ closeMissLimit` → `closed` with `closed: null`, `closedAt = now`, then deleted. Otherwise it is left as is.

- [ ] **Step 1: Write failing tests** in `test/detector.test.ts`:
  - `baselining emits no events and stores all`: 2 fresh, 0 rows, `baselining: true` → `events.length === 0` and `upserts.length === 2`.
  - `new position emits opened`: → one `opened` event, and the upsert has `feeBaselineUsd === fresh.collectedFee`.
  - `fee increase at threshold emits fee_collected`: row baseline 10 and fresh `collectedFee 11` with min 1 → `deltaUsd === 1`, and the upsert baseline is 11.
  - `small fee increases accumulate`: baseline 10 → fresh 10.6 gives no event and the baseline stays 10; then the next diff with fresh 11.2 gives `deltaUsd ≈ 1.2` (`toBeCloseTo`).
  - `fee decrease does not lower baseline`: baseline 10 and fresh 0 → no event and the baseline stays 10.
  - `missing position increments missCount and flags suspects`: → `missCount === 1`, `hasSuspects === true`, no events.
  - `reappearing suspect resets missCount silently`: row `missCount 2` that is present in fresh → `missCount 0`, no events.
  - `same tokenId on v3 and v4 are distinct positions`: row `uniswap_v3:1`, fresh contains `uniswap_v3:1` and `uniswap_v4:1` → exactly one `opened`, for v4.
  - `confirmCloses closes suspect found in historical`: → one `closed` with `closed.pnlValue === 184.3` and `deletes` equal to `[key]`.
  - `confirmCloses keeps unmatched suspect under limit`: `missCount 2`, limit 3 → no events, no deletes.
  - `confirmCloses forces close at limit`: `missCount 3`, limit 3, not in historical → `closed` with `closed === null` and `closedAt === now`, and the key is deleted.

- [ ] **Step 2: Run** `npm test -- detector` and expect FAIL.

- [ ] **Step 3: Implement** `src/detector.ts` and `test/fixtures/make.ts`.

- [ ] **Step 4: Run** `npm test -- detector` and expect PASS.

- [ ] **Step 5: Commit** `feat: add pure position change detector`.

---

### Task 4: Message formatting

**Files:**
- Create: `src/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `AlertEvent`, `WalletRef` (Task 3), `OpenPosition`, `TokenInfo` (Task 2), `makePosition` (Task 3).
- Produces:
  ```ts
  export function escapeHtml(s: string): string            // & < > "
  export function shortAddress(a: string): string          // first 6 + "…" + last 4
  export function walletLink(address: string): string      // <a href="https://app.lpagent.io/portfolio?address=..&chain=ROBINHOOD">short</a>
  export function walletName(w: WalletRef): string         // escaped label, else shortAddress
  export function baseTokenSide(p: OpenPosition): 'token0' | 'token1' | 'both'
  export function pickCaTokens(p: OpenPosition): TokenInfo[]
  export function rangePercent(p: OpenPosition): { lower: number; upper: number } // rounded ints
  export function formatDuration(ms: number): string       // "3d 4h" | "5h 12m" | "7m"
  export function formatEvent(e: AlertEvent): string
  export function formatBaselined(w: WalletRef, count: number): string
  export function formatApiDown(reason: string): string    // "⚠️ LP Agent API failing: <reason>"
  export function formatApiRecovered(): string             // "✅ LP Agent API recovered"
  ```

**Decisions:**
- **Quote rank by uppercase symbol:** USDG/USDC/USDT = 2, WETH/ETH = 1, others = 0. `baseTokenSide`: if the ranks differ, the lower-ranked side is the base; if both are 0, `'both'`; if both are equal and non-zero, `'token0'`. `pickCaTokens` returns `[token0, token1]` for `'both'`, otherwise the base token.
- **`rangePercent`:** `P(tick) = 1.0001^tick × 10^(dec0 − dec1)` and `Pcur = price0 / price1`. `lower = round((P(tickLower)/Pcur − 1) × 100)`, and the same for upper. If the base is `token1`: invert all three prices, then swap lower and upper.
- **Number formats:** USD uses `Intl` en-US currency with 2 decimals. ETH uses `Intl` with `maximumSignificantDigits: 3` plus `" ETH"`. Signed percent: `+7.5%` / `-3.2%` (1 decimal) for PnL; range uses whole numbers with an explicit sign (`+0%`). Fee tier: `feeTier / 10000` without trailing zeros, plus `%`. Protocol: `uniswap_v3` → `Uniswap V3`, `uniswap_v4` → `Uniswap V4`, anything else unchanged.
- **Exact layout** (lines joined with `\n`; `<b>` on the header line). Pair names and symbols are escaped:
  ```
  <b>🟢 OPENED · {name}</b>
  {pair} · {Protocol} · {fee}%
  Deposited: {inputValue $} ({inputNative ETH})
  Range: {lower}% ~ {upper}% · {in range ✅ | out of range ⚠️}
  Position #{tokenId} · Wallet {walletLink}
  CA {SYMBOL}: <code>{address}</code>          (one line per CA token)

  <b>💰 FEES COLLECTED · {name}</b>
  {pair} · {Protocol}
  Collected: {deltaUsd $} ({deltaNative ETH})
  Total collected on this position: {position.collectedFee $}
  Position #{tokenId} · Wallet {walletLink}
  CA {SYMBOL}: <code>{address}</code>

  <b>🔴 CLOSED · {name}</b>
  {pair} · {Protocol}
  Held: {formatDuration(closedAt − createdAt)}
  PnL: {+$184.30 (+7.5%) | unavailable}
  Fees earned: {closed?.collectedFee ?? position.collectedFee $}
  Position #{tokenId} · Wallet {walletLink}
  ```
  `formatBaselined`: `👀 Tracking <b>{name}</b>: {n} open position{s}`.

- [ ] **Step 1: Write failing tests** in `test/format.test.ts`:
  - `shortAddress`: `0x12ab34…` (42 chars) → `0x12ab…9f3c`.
  - `pickCaTokens`: WETH/USDG → `[WETH]`; TSLA/WETH → `[TSLA]`; TSLA/NVDA → both; USDC/USDG → `[token0]`.
  - `rangePercent in range`: equal decimals (18/18), `tickLower 0`, `tickUpper 6932`, `price0 1.5`, `price1 1`, token0 TSLA, token1 USDG → `{lower: -33, upper: 33}`.
  - `range orients to base token when base is token1`: the same ticks and prices but token0 USDG, token1 TSLA → `{lower: -25, upper: 50}` (inverted: Pcur = 1/1.5, bounds 1/2 and 1, swapped).
  - `formatDuration`: `(3*24+4)*3600e3` → `"3d 4h"`; `(5*60+12)*60e3` → `"5h 12m"`; `7*60e3` → `"7m"`.
  - `formatEvent opened` (the TSLA/USDG position from the in-range test, `feeTier 3000`): matches an inline snapshot, contains `Range: -33% ~ +33% · in range ✅`, contains `<code>` + the full token address, contains the wallet link URL with `chain=ROBINHOOD`, and contains `· 0.3%`.
  - `formatEvent fee_collected`: contains `Collected: $38.20 (0.0126 ETH)` and `Total collected on this position: $112.40`.
  - `formatEvent closed with pnl`: contains `Held: 3d 4h`, `PnL: +$184.30 (+7.5%)` and `Fees earned: $151.10`, and does not contain `CA `.
  - `formatEvent closed forced`: contains `PnL: unavailable`.
  - `escapes html in label and symbol`: label `a<b&c` and pairName `X<Y` → the output contains `a&lt;b&amp;c` and `X&lt;Y`, and contains no raw `<b&`.
  - `name falls back to short address`: label `null` → the header contains `0x12ab…9f3c`.

- [ ] **Step 2: Run** `npm test -- format` and expect FAIL.

- [ ] **Step 3: Implement** `src/format.ts`.

- [ ] **Step 4: Run** `npm test -- format` and expect PASS. Review the inline snapshot by eye against spec §6.2.

- [ ] **Step 5: Commit** `feat: add Telegram alert formatting`.

---

### Task 5: SQLite store

**Files:**
- Create: `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `PositionRow`, `WalletRef` (Task 3).
- Produces:
  ```ts
  export interface WalletRecord extends WalletRef { addedAt: string; baselined: boolean; lastPolledAt: string | null; openCount: number }
  export class DuplicateError extends Error { field: 'address' | 'label' }
  export interface Db {
    addWallet(address: string, label: string | null, now: string): void;    // address stored lowercased
    removeWallet(addressOrLabel: string): WalletRecord | null;              // 0x… matches address, else label (NOCASE)
    getWallet(address: string): WalletRecord | null;
    listWallets(): WalletRecord[];                                          // ordered by added_at, rowid
    getPositions(address: string): PositionRow[];
    applyPollResult(address: string, r: { upserts: PositionRow[]; deletes: string[]; markBaselined?: boolean; polledAt?: string }): void; // one transaction
    walletsWithSuspects(): string[];                                        // wallets having any miss_count > 0
    close(): void;
  }
  export function openDb(path: string): Db  // creates parent dir; ':memory:' allowed
  ```

**Schema:** as in spec §5.1, with `position_key` in place of `token_id`. Label column: `label TEXT UNIQUE COLLATE NOCASE`. Run `PRAGMA foreign_keys = ON` and `PRAGMA journal_mode = WAL` (skip WAL for `:memory:`). `data_json` stores `JSON.stringify(OpenPosition)`.

- [ ] **Step 1: Write failing tests** in `test/db.test.ts` (each uses `openDb(':memory:')`):
  - `addWallet lowercases and lists`: add `0xABC…` → `listWallets()[0].address` is lowercase, `baselined === false`, `openCount === 0`.
  - `duplicate address rejected`: adding the same address in a different case throws `DuplicateError` with field `address`.
  - `duplicate label rejected case-insensitively`: `Whale` vs `whale` throws `DuplicateError` with field `label`.
  - `applyPollResult upserts, deletes, marks baselined`: after upserting 2 rows and marking baselined → `getPositions` round-trips `PositionRow` (deep equal), `baselined === true`, `openCount === 2`, `lastPolledAt` is set. Deleting one key leaves 1.
  - `removeWallet by label cascades positions`: → returns the record; `getPositions` is empty.
  - `removeWallet unknown returns null`.
  - `walletsWithSuspects`: only the wallet with a `missCount 1` row is returned.

- [ ] **Step 2: Run** `npm test -- db` and expect FAIL.

- [ ] **Step 3: Implement** `src/db.ts` with prepared statements and `db.transaction` for `applyPollResult`. Map `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY` to `DuplicateError`.

- [ ] **Step 4: Run** `npm test -- db` and expect PASS.

- [ ] **Step 5: Commit** `feat: add SQLite store for wallets and position snapshots`.

---

### Task 6: Poller

**Files:**
- Create: `src/poller.ts`
- Test: `test/poller.test.ts`

**Interfaces:**
- Consumes: `Db`, `openDb` (Task 5); `LpAgentClient`, `LpAgentError` (Task 2); `diffOpening`, `confirmCloses` (Task 3); `formatEvent`, `formatBaselined`, `formatApiDown`, `formatApiRecovered` (Task 4); `Config` (Task 1).
- Produces:
  ```ts
  export type Notify = (html: string) => Promise<void>;   // rejects if delivery failed
  export interface PollerStatus { startedAt: Date; walletCount: number; cycleSeconds: number; pendingConfirms: number; lastError: { message: string; at: Date } | null; apiDown: boolean }
  export interface Poller { tick(): Promise<void>; start(): void; stop(): Promise<void>; status(): PollerStatus }
  export function createPoller(deps: { db: Db; client: LpAgentClient; notify: Notify; logger: import('pino').Logger;
    config: Pick<Config, 'rpmLimit' | 'feeAlertMinUsd' | 'closeMissLimit'>; now?: () => Date }): Poller
  ```

**Behavior of `tick()`** (one request at most):
1. If `now < nextAllowedAt` (backoff), return.
2. If `pendingConfirm` (an insertion-ordered `Set<string>`, seeded from `db.walletsWithSuspects()` at creation) is non-empty, take the first wallet and run a confirm. Otherwise take the next wallet from `db.listWallets()` by round-robin cursor and run an opening poll. No wallets → return.
3. **Opening poll:** read the rows and `baselining = !wallet.baselined`, then `getOpening`. After the await, re-read `getWallet`; if it's null, stop (no notify, no commit). Then `diffOpening`, notify each event in order, then `formatBaselined` if baselining. Commit with `applyPollResult({upserts, deletes, markBaselined: baselining, polledAt})`. If `hasSuspects`, add to `pendingConfirm`.
4. **Confirm:** suspects = rows with `missCount > 0`. If there are none, delete from the set and return. Otherwise `getHistorical(addr, min(lastSeenAt) − 1h)`. Re-check `getWallet` as in step 3 (if it's gone, delete from the set and stop). Then `confirmCloses`, notify, commit the deletes, and delete from the set.
5. **On `LpAgentError`:** record `lastError` and set `backoffMs = min(backoffMs ? backoffMs*2 : interval*2, 300_000)` and `nextAllowedAt = now + backoffMs`. If this is the first error in the streak, set `errorSince = now`. If `now − errorSince ≥ 15 min` and the down alert hasn't been sent, `notify(formatApiDown(message))` (if that send fails, just log it).
6. **On success:** reset the backoff and `errorSince`. If the down alert had been sent, `notify(formatApiRecovered())`.
7. **On a notify rejection during an event send:** log it, commit nothing, and leave `pendingConfirm` unchanged. This is not an API error.

`interval = 60_000 / rpmLimit`. `start()` loops `await tick(); await sleep(interval)` until stopped, and a thrown error inside the loop is logged but never ends it. `stop()` resolves after the in-flight tick finishes. `cycleSeconds = walletCount × interval / 1000`.

- [ ] **Step 1: Write failing tests** in `test/poller.test.ts`. Use `openDb(':memory:')`, a fake client whose responses are queued per method, a `notify` that pushes to `sent: string[]` (or rejects when `failNext` is set), a mutable `now`, and `pino({level:'silent'})`:
  - `first poll baselines silently`: 2 positions → `sent` is exactly one message containing `Tracking`, and the wallet is `baselined`.
  - `new position after baseline alerts opened`: → `sent[0]` contains `OPENED`.
  - `round-robins wallets`: 2 wallets and 2 ticks → `getOpening` is called with A then B.
  - `missing position triggers historical confirm next tick`: tick 1 opening omits a position; tick 2 calls `getHistorical` (not `getOpening`) with `from` = `lastSeenAt − 1h` and sends `CLOSED`; the row is deleted.
  - `forced close after miss limit`: historical is always empty and opening keeps omitting the position. After 3 opening polls and the confirms that follow, exactly one `CLOSED` with `PnL: unavailable` is sent.
  - `invalid response does not increment miss counts`: `getOpening` rejects with `invalid_response` → the row keeps `missCount 0`, `pendingConfirm` is empty, `status().lastError` is set.
  - `backs off after api error`: after an error at t0, a tick at t0+1s makes no client call; a tick at t0+25s does.
  - `api down alert after 15 minutes, once, then recovered`: errors from t0 to t0+16min (with ticks spread out) → exactly one `failing`; then a success sends `recovered`.
  - `telegram failure commits nothing`: `failNext` on an `OPENED` send → no row stored; the next tick re-polls the same wallet and sends `OPENED`.
  - `skips commit when wallet removed mid-request`: the fake `getOpening` calls `db.removeWallet` before resolving → no throw, `sent` is empty, no rows.

- [ ] **Step 2: Run** `npm test -- poller` and expect FAIL.

- [ ] **Step 3: Implement** `src/poller.ts`.

- [ ] **Step 4: Run** `npm test` (whole suite) and expect PASS.

- [ ] **Step 5: Commit** `feat: add rate-limited poller with close confirmation and backoff`.

---

### Task 7: Telegram notify, commands and bot

**Files:**
- Create: `src/notify.ts`, `src/commands.ts`, `src/bot.ts`
- Test: `test/notify.test.ts`, `test/commands.test.ts`

**Interfaces:**
- Consumes: `Db`, `DuplicateError` (Task 5); `PollerStatus`, `Notify` (Task 6); `walletLink`, `walletName`, `escapeHtml`, `shortAddress` (Task 4).
- Produces:
  ```ts
  // notify.ts
  export async function sendWithRetry(send: () => Promise<unknown>, opts?: { attempts?: number; sleep?: (ms: number) => Promise<void> }): Promise<void>
  export function createTelegramNotify(api: import('grammy').Api, chatId: number): Notify // HTML, link previews disabled
  // commands.ts (return HTML reply text)
  export function cmdAdd(db: Db, args: string, now: Date): string
  export function cmdRemove(db: Db, args: string): string
  export function cmdList(db: Db, now: Date): string
  export function cmdStatus(s: PollerStatus, now: Date): string
  // bot.ts
  export function createBot(opts: { token: string; ownerId: number; db: Db; getStatus: () => PollerStatus }): import('grammy').Bot
  export const BOT_COMMANDS: { command: string; description: string }[]
  ```

**Decisions:**
- `sendWithRetry`: up to `attempts` (default 3). If the error is a `GrammyError` with `parameters.retry_after`, it sleeps that many seconds; otherwise it sleeps 1 s, then 2 s. After the last failure it rethrows.
- **`/add` parsing:** the first token must match `^0x[0-9a-fA-F]{40}$`; the rest, trimmed, is the label (empty → null, at most 32 chars). Replies:
  - `Usage: /add &lt;0x address&gt; [label]`
  - `Label must be 32 characters or fewer.`
  - `Already tracking {short}.`
  - `Label "{label}" is already used.`
  - `✅ Added {name}. Baselining…`
- **`/remove` replies:** `Usage: /remove &lt;address or label&gt;`, `No wallet matches "{arg}".`, `🗑 Removed {name}.`
- **`/list`:** `No wallets tracked. Use /add &lt;address&gt; [label].` when empty. Otherwise `<b>Tracked wallets ({n})</b>`, then one line per wallet: `{name} · {walletLink} · {openCount} open · checked {ago}`, where `ago` is `never` / `{s}s ago` / `{m}m ago` / `{h}h ago`.
- **`/status`:** lines `Uptime: {formatDuration}`, `Wallets: {n} · full cycle ≈ {cycleSeconds}s`, `Pending close checks: {n}`, `Last API error: {message} ({ago})` or `none`, and `API: ⚠️ failing` when `apiDown` is true.
- **`createBot`:** the first middleware drops any update where `ctx.from?.id !== ownerId` (no reply). It registers `add`, `remove`, `list` and `status` to reply with `{ parse_mode: 'HTML', link_preview_options: { is_disabled: true } }`. `BOT_COMMANDS` holds the four commands and their descriptions for `setMyCommands`.

- [ ] **Step 1: Write failing tests:**
  - `notify.test.ts`: `retries then succeeds` (fails twice, succeeds on the 3rd; 3 calls; sleep called with 1000 then 2000); `honors retry_after` (a `GrammyError`-shaped error with `parameters.retry_after: 4` → sleep 4000); `rethrows after attempts` (always fails → rejects after 3 calls).
  - `commands.test.ts` (`openDb(':memory:')`): `add valid with label`; `add rejects bad address` (usage reply, nothing stored); `add duplicate address any case`; `add duplicate label`; `add escapes label in reply` (label `<x>` → reply contains `&lt;x&gt;`); `remove by label`; `remove unknown`; `list empty`; `list shows count and link` (contains `1 open` and `chain=ROBINHOOD`); `status shows last error` (contains the message and `ago`).

- [ ] **Step 2: Run** `npm test -- notify commands` and expect FAIL.

- [ ] **Step 3: Implement** `notify.ts`, `commands.ts` and `bot.ts`. `bot.ts` has no unit test; it is covered by `npm run typecheck` and Task 9.

- [ ] **Step 4: Run** `npm test && npm run typecheck` and expect PASS.

- [ ] **Step 5: Commit** `feat: add Telegram commands, owner guard and retrying notifier`.

---

### Task 8: Entry point, probe script, deployment and README

**Files:**
- Create: `src/index.ts`, `scripts/probe.ts`, `deploy/lp-tracker.service`, `README.md`

**Interfaces:**
- Consumes: everything above.

**`src/index.ts`:** `loadConfig(process.env)`; pino logger (level `info`); `openDb(config.dbPath)`; `createLpAgentClient`; `createBot`; `createTelegramNotify(bot.api, ownerId)`; `createPoller`. Then `await bot.api.setMyCommands(BOT_COMMANDS)`, `poller.start()`, `bot.start({ drop_pending_updates: true })` (not awaited), and `bot.catch` logs errors. On `SIGTERM`/`SIGINT`: `await poller.stop()`, `await bot.stop()`, `db.close()`, `process.exit(0)`. Config errors are logged and then `process.exit(1)`.

**`scripts/probe.ts`:** usage `npm run probe -- <address> [--send]`. Calls the raw `/lp-positions/opening` with `fetch` and saves the body to `data/probe-opening.json`. Then it prints, for each position after parsing with the Task 2 schema: `tokenId`, pair, `collectedFee`, `collectedFeeNative`, `inputValue`, `inputNative`, `priceRange` from the raw item, `rangePercent`, and `formatEvent({type:'opened', …})`. With `--send`, it also sends each formatted message to the owner through `createTelegramNotify`.

**`deploy/lp-tracker.service`:** `[Unit] After=network-online.target`. `[Service]` with `User=lptracker`, `WorkingDirectory=/opt/lp-tracker`, `EnvironmentFile=/opt/lp-tracker/.env`, `ExecStart=/usr/bin/node dist/index.js`, `Restart=always`, `RestartSec=5`. `[Install] WantedBy=multi-user.target`.

**`README.md`:** what the bot does (3 alerts, 4 commands) and setup. Setup covers: BotFather `/newbot` → token; finding your numeric ID by messaging `@userinfobot`; an LP Agent key from https://portal.lpagent.io/; local run (`cp .env.example .env`, `npm ci`, `npm test`, `npm run probe -- <addr>`, `npm run dev`); VPS install (Node 22 via NodeSource, `useradd --system lptracker`, clone to `/opt/lp-tracker`, `npm ci && npm run build`, `.env` with `chmod 600`, copy the unit, `systemctl enable --now lp-tracker`); logs (`journalctl -u lp-tracker -f`); updating (`git pull && npm ci && npm run build && systemctl restart lp-tracker`); backup (`data/tracker.db`); and the polling-latency note (≈ wallets × 12 s on Basic).

- [ ] **Step 1: Implement** the four files.
- [ ] **Step 2: Run** `npm run build && npm test` and expect it to compile cleanly and pass.
- [ ] **Step 3: Smoke test without secrets:** `node dist/index.js` with an empty env exits with code 1 and logs `Invalid config: …TELEGRAM_BOT_TOKEN…`.
- [ ] **Step 4: Commit** `feat: add entry point, probe script, systemd unit and README`.

---

### Task 9: Live verification (requires the user's keys)

The user's `.env` (BotFather token, owner ID, LP Agent key) and one active Robinhood Chain LP wallet address are needed. Ask the user for the wallet address. The user fills in `.env` themselves; never paste keys into chat or commit them.

- [ ] **Step 1:** `npm run probe -- <wallet>`. Check `data/probe-opening.json`:
  - The zod parse succeeds. If a field mismatches, fix `types.ts` and replace `test/fixtures/opening.json` with a redacted copy of the real response, then rerun `npm test`.
  - `collectedFee` is in USD (it matches the LP Agent web UI for that position).
  - `rangePercent` matches the position's range shown in the LP Agent UI (the direction and the base token are correct).
- [ ] **Step 2:** `npm run probe -- <wallet> --send`. Confirm in Telegram that the message renders, the wallet link opens the LP Agent portfolio, and tapping the CA copies it.
- [ ] **Step 3:** `npm run dev`. In Telegram: `/add <wallet> Test` gives `Added` and then `Tracking Test: N open positions`. `/list` and `/status` reply. A message from another account gets no reply.
- [ ] **Step 4:** Record any adjustments made, then commit `fix: align LP Agent parsing with live responses` (only if anything changed).
