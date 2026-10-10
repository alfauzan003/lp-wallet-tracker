# LP Wallet Tracker — Design

Date: 2026-10-10
Status: Approved in brainstorming, pending spec review

## 1. Goal

A personal Telegram bot that watches a small set of wallets on **Robinhood Chain** and notifies the owner when a tracked wallet:

- **opens** an LP position,
- **collects fees** from an LP position,
- **closes** an LP position.

Data comes from the **LP Agent API**. Written in **TypeScript**, deployed on a **VPS without Docker** (systemd).

### Success criteria

- Every open / fee collection (≥ $1) / close on a tracked wallet produces exactly one alert, typically within ~2 minutes.
- No false "closed" alerts caused by API glitches.
- Restarting the service never replays old positions as new alerts.
- Never exceeds the LP Agent Basic plan rate limit (5 requests/minute).

### Constraints and scope

- Single user: one owner Telegram account controls the bot and receives all alerts.
- LP Agent **Basic** plan: 5 RPM. Fewer than 10 tracked wallets.
- Out of scope: alerts for adding/removing liquidity on a position that stays open, multi-user support, webhooks, a web UI, positions opened and closed entirely between two polls (see §5.4).

## 2. External API facts (LP Agent)

- Base URL: `https://api.lpagent.io/open-api/v1`
- Auth header: `x-api-key: <LPAGENT_API_KEY>`
- Chain selection: query `chain=ROBINHOOD` (chain ID 4663, Uniswap V3 + V4). Unrecognized values silently fall back to `SOL`, so the client must always send `ROBINHOOD` explicitly.
- No webhooks or streams; polling only.
- Rate limit: Basic plan, 5 RPM.

Endpoints used:

| Endpoint | Use | Fields used |
|---|---|---|
| `GET /lp-positions/opening?owner&chain=ROBINHOOD` | Current open positions for a wallet | `tokenId`, `pairName`, `pool`, `protocol`, `poolInfo.fee`, `token0`, `token1`, `token0Info`, `token1Info`, `decimal0`, `decimal1`, `inputValue`, `inputNative`, `collectedFee`, `collectedFeeNative`, `tickLower`, `tickUpper`, `price0`, `price1`, `inRange`, `createdAt` |
| `GET /lp-positions/historical?owner&chain=ROBINHOOD&from_date&pageSize=100` | Confirm closes, get final PnL | `tokenId`, `status`, `closeAt`, `createdAt`, `pnl.value`, `pnl.percent`, `collectedFee`, `pairName`, `protocol` |

Known API gaps:
- No transaction hashes in any response.
- The direction and units of `priceRange` are not documented. The range % is computed from ticks instead (§6.2).
- It is unclear whether `collectedFee` is in USD. It is treated as USD and `collectedFeeNative` as ETH, to be checked against a live response during implementation.

## 3. Architecture

A single long-running Node.js process runs two components:

1. **Telegram bot** (grammY, long polling, so no public endpoint or TLS is needed).
2. **Poller**, a rate-limited round-robin loop over tracked wallets.

State lives in one SQLite file (`better-sqlite3`). The process is managed by systemd.

### 3.1 Module layout

```
src/
  index.ts           entry: load config, open DB, start bot + poller, graceful shutdown
  config.ts          env vars, validated with zod
  lpagent/client.ts  LP Agent HTTP client: getOpening(owner), getHistorical(owner, fromDate)
  lpagent/types.ts   zod schemas for the fields we use (extra fields allowed)
  db.ts              SQLite access: wallets, position snapshots, pending closes
  detector.ts        PURE: diffOpening(snapshot, fresh, cfg) and confirmCloses(suspects, historical, cfg)
                     -> events + row upserts/deletes
  poller.ts          token-bucket scheduler; picks next request; calls detector; dispatches alerts
  bot.ts             grammY bot: /add /remove /list /status; owner-only guard
  format.ts          event -> Telegram HTML message
deploy/
  lp-tracker.service systemd unit
test/
  detector.test.ts, format.test.ts, client.test.ts, fixtures/*.json
```

### 3.2 Unit boundaries

- **`lpagent/*`** is the only code that knows LP Agent URLs and field names. It returns typed domain objects.
- **`detector`** has no I/O and holds all the change-detection logic. It is fully unit-tested.
- **`poller`** is the only code that handles timing, rate limits and retries.
- **`format`** is pure: event in, string out.
- **`db`** is the only code that runs SQL.

## 4. Configuration (`.env`)

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | | Token from BotFather |
| `TELEGRAM_OWNER_ID` | yes | | Owner's numeric Telegram user ID; the only allowed commander and the alert destination |
| `LPAGENT_API_KEY` | yes | | LP Agent API key |
| `RPM_LIMIT` | no | `5` | LP Agent requests per minute |
| `FEE_ALERT_MIN_USD` | no | `1` | Minimum accumulated fee increase that triggers an alert |
| `CLOSE_MISS_LIMIT` | no | `3` | Consecutive misses before a forced close alert |
| `DB_PATH` | no | `./data/tracker.db` | SQLite file path |

## 5. Data model and detection

### 5.1 Tables

```sql
wallets(
  address     TEXT PRIMARY KEY,   -- lowercased 0x address
  label       TEXT,               -- optional, unique when set (case-insensitive)
  added_at    TEXT NOT NULL,
  baselined   INTEGER NOT NULL DEFAULT 0,
  last_polled_at TEXT
)

positions(
  wallet            TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  token_id          TEXT NOT NULL,
  data_json         TEXT NOT NULL,   -- last API record (for formatting close alerts)
  fee_baseline_usd  REAL NOT NULL,   -- collectedFee at last fee alert (or at open)
  fee_baseline_native REAL NOT NULL,
  miss_count        INTEGER NOT NULL DEFAULT 0, -- consecutive successful polls where absent
  last_seen_at      TEXT NOT NULL,
  PRIMARY KEY (wallet, token_id)
)
```

A "suspected close" is a `positions` row with `miss_count > 0`.

### 5.2 Baselining

- On `/add`, the wallet is inserted with `baselined = 0`.
- The first successful `/opening` poll of an un-baselined wallet stores every position silently (fee baseline = current `collectedFee`), sets `baselined = 1`, and sends one message: `Tracking <label>: N open positions`.
- On restart, existing snapshots are used as they are, so nothing is replayed.

### 5.3 Detection rules (`detector`)

Input: the stored rows for a wallet, the fresh `/opening` list (from a **successful** response only), and the threshold. Output: events plus row upserts and deletes.

| Condition | Effect |
|---|---|
| `tokenId` in fresh list, not in snapshot | Emit **Opened**; insert row with fee baseline = current `collectedFee`, `miss_count = 0` |
| In both; `collectedFee − fee_baseline_usd ≥ FEE_ALERT_MIN_USD` | Emit **FeeCollected** (delta USD/native, total collected); set baseline = current |
| In both; delta below threshold | No event; baseline **unchanged** (small collections add up) |
| In both | Update `data_json`, `last_seen_at`, reset `miss_count = 0` |
| In snapshot, not in fresh list | Increment `miss_count`; add to the close-confirmation queue |

### 5.4 Close confirmation

- For a wallet with suspected closes, the poller schedules one `/historical?owner&chain=ROBINHOOD&from_date=<min(last_seen_at) − 1h>&pageSize=100` request.
- If a suspected `tokenId` is found there, emit **Closed** with the final PnL, fees earned (`collectedFee`) and hold duration (`closeAt − createdAt`), then delete the row.
- If it isn't found, keep the row. When `miss_count ≥ CLOSE_MISS_LIMIT`, emit **Closed** with "PnL unavailable" (using the last `data_json`) and delete the row.
- If the position reappears in `/opening`, `miss_count` resets to 0 with no event.
- A close never emits a separate FeeCollected alert. Fees collected at close are part of the Closed alert.
- Known limitation: a position opened and closed entirely between two polls of its wallet is not reported.

### 5.5 Ordering and delivery guarantee

For each event: send the Telegram message first, then commit the DB change. A crash between the two may cause a duplicate alert, never a missed one. All of a wallet's row changes from one poll are committed in a single transaction after its alerts are sent. If one alert fails to send after retries, nothing from that poll is committed, and the same diff is recomputed on the next poll.

## 6. Telegram

### 6.1 Commands (owner only; messages from anyone else are ignored without reply)

| Command | Behavior |
|---|---|
| `/add <address> [label]` | Validate `^0x[0-9a-fA-F]{40}$`; lowercase; reject duplicates; insert un-baselined; reply "Added, baselining…" |
| `/remove <address or label>` | Delete wallet (positions cascade); reply with confirmation |
| `/list` | Each wallet: label, short address (linked), open position count, last polled time |
| `/status` | Uptime, current full-cycle time, wallets count, pending close checks, last API error and when |

Commands are registered through `setMyCommands` at startup.

### 6.2 Alert formats (HTML parse mode)

Shared parts:
- **Wallet link**: `<a href="https://app.lpagent.io/portfolio?address=<address>&chain=ROBINHOOD">0x12ab…9f3c</a>` (first 6 and last 4 characters).
- **CA line**: `CA <SYMBOL>: <code><full address></code>`, which copies when tapped. The token shown is the non-quote token. Quote priority: stablecoins (USDG, USDC, USDT) first, then WETH/ETH. If neither token is a quote token, show one CA line per token. If both are quote tokens (e.g. WETH/USDG), show the lower-priority one (WETH).
- **Range %**: `lower% = (P_lower / P_current − 1) × 100`, `upper% = (P_upper / P_current − 1) × 100`, rounded to whole percent and signed (`+0%` for zero). Prices in token1-per-token0: `P_tick = 1.0001^tick × 10^(decimal0 − decimal1)`. `P_current = price0 / price1` (USD prices). The suffix is `in range ✅` or `out of range ⚠️` based on `inRange`. This formula must be checked against one live position during implementation.
- All user-supplied and API text is HTML-escaped.

```
🟢 OPENED · Whale1
WETH/USDG · Uniswap V3 · 0.3%
Deposited: $2,450.00 (0.81 ETH)
Range: -50% ~ +0% · in range ✅
Position #48213 · Wallet 0x12ab…9f3c
CA WETH: 0x4200…0006   (full address, in <code>)

💰 FEES COLLECTED · Whale1
WETH/USDG · Uniswap V3
Collected: $38.20 (0.0126 ETH)
Total collected on this position: $112.40
Position #48213 · Wallet 0x12ab…9f3c
CA WETH: 0x4200…0006   (full address, in <code>)

🔴 CLOSED · Whale1
WETH/USDG · Uniswap V3
Held: 3d 4h
PnL: +$184.30 (+7.5%)
Fees earned: $151.10
Position #48213 · Wallet 0x12ab…9f3c
```

- The label falls back to the short address when no label is set.
- The fee tier is taken from `poolInfo.fee` (hundredths of a bip, e.g. 3000 → 0.3%).
- The protocol `uniswap_v3`/`uniswap_v4` is displayed as `Uniswap V3`/`Uniswap V4`.

### 6.3 Other bot messages

- `Tracking <label>: N open positions` after baselining.
- `⚠️ LP Agent API failing: <reason>`, sent once when errors persist for more than 15 minutes, and `✅ LP Agent API recovered` when they stop.

## 7. Poller

- Token bucket: one request every `60 / RPM_LIMIT` seconds (12 s by default).
- On each tick, one request:
  1. A wallet with suspected closes waiting for `/historical` confirmation (oldest first), otherwise
  2. The next wallet in round-robin order (`/opening`).
- With 8 wallets, each wallet is polled roughly every 1.6–2 minutes.
- When the wallet list is empty, the poller idles. `/add` and `/remove` take effect on the next tick.

## 8. Error handling

| Failure | Handling |
|---|---|
| LP Agent 429 / 5xx / network / timeout (10 s) | Skip this tick. Global backoff doubles up to 5 minutes and resets on success. Snapshot unchanged. **Never treated as a close.** |
| Response fails zod validation | Log the payload summary, skip the wallet, count as an API error |
| API errors for more than 15 minutes | One Telegram warning; one recovery message when it works again |
| Telegram send failure | Retry 3 times with backoff (honor `retry_after`). If it still fails, don't commit this poll's changes (§5.5) |
| SIGTERM / SIGINT | Stop scheduling, finish the in-flight tick, stop the bot, close the DB, exit 0 |

Logging uses structured single-line logs on stdout (`pino`), viewed with `journalctl`.

## 9. Deployment

- Node.js 22 LTS on the VPS. `npm ci && npm run build` compiles `src` to `dist` with `tsc`.
- `deploy/lp-tracker.service`: `ExecStart=/usr/bin/node dist/index.js`, `WorkingDirectory=/opt/lp-tracker`, `EnvironmentFile=/opt/lp-tracker/.env`, `Restart=always`, `RestartSec=5`, dedicated non-root user.
- The README covers creating a bot with BotFather, finding your numeric user ID, getting an LP Agent API key, configuring `.env`, installing and enabling the service, viewing logs, and backing up `data/tracker.db`.

## 10. Testing

- **Vitest** unit tests:
  - `detector`: open; fee collection ≥ threshold; under-threshold amounts adding up to an alert; suspected close → confirmed via historical; reappearance resets the miss count; forced close after `CLOSE_MISS_LIMIT`; close with fees gives one Closed event; baselining emits no events.
  - `format`: snapshot tests for all three alerts; range % for in-range, below-range and above-range cases; quote-token CA selection; HTML escaping.
  - `client`: parsing recorded fixture responses with a stubbed `fetch`; always sends `chain=ROBINHOOD` and `x-api-key`; error classification (429, 5xx, invalid shape).
- **Manual verification** before deploying: run locally with the real API key against one known active Robinhood Chain wallet. Confirm the field units (`collectedFee` USD), the range % direction, and the alert rendering in Telegram.
