# Instant Close Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send the CLOSED alert on the first miss with `PnL: pending…`, then edit that Telegram message with the real stats once `/historical` has them (or `PnL: unavailable` after 60 min, or `FALSE ALARM` if the position comes back).

**Architecture:** Missing positions move from `positions` into a new `closes` table that holds the Telegram `message_id` and a check schedule. Close-check polls (which replace the confirm polls) query `/historical` for wallets with due closes and edit messages in place. The pure logic lives in `detector.ts` and `format.ts`; `poller.ts` orchestrates; `notify.ts` gains `send → message_id` and `edit`.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.9), better-sqlite3, grammy, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-instant-close-alerts-design.md`

## Global Constraints

- Check offsets from `detected_at`: exactly `[30s, 1m, 2m, 4m, 8m, 15m, 30m, 60m]`. Give up when not found and `now ≥ detected_at + 60 min`.
- A close expires only after a **successful** `/historical` response. A failed request advances nothing.
- Edits are silent: `editMessageText` only, never a new message for an edit.
- Exact copy: `PnL: pending…` (Unicode ellipsis U+2026), `<b>⚪ FALSE ALARM · {name}</b>`, `Position is still open.`
- Telegram error matching is by the error's `description` string: `/message is not modified/i` counts as `'ok'`, `/message to edit not found/i` as `'gone'`. Neither is retried.
- Edit rejected during a close check: leave `attempts` unchanged, set `next_check_at = now + 5 min`, and record it as `lastSendError`. If `now ≥ detected_at + 2 h`, delete the close and log an error instead. (This makes the spec's "retried later" concrete and keeps a permanently failing edit from looping.)
- `positions.miss_count` stays in the schema and is always written as `0`. `PositionRow` loses its `missCount` field.
- `CLOSE_MISS_LIMIT` is removed. An old `.env` that still sets it must still load.
- Vitest doesn't typecheck. `npm run typecheck` is only expected to pass from Task 5 on. Each task runs its own test file; Task 6 runs everything.

## Review Focus

1. **Position comes back after its close was finalized** (found, expired or gone): it must alert as a normal OPENED and must not look up a deleted close. → Task 5 test `reappearing after the close is finalized alerts OPENED`.
2. **Several positions on one wallet close in the same poll:** each gets its own message and `message_id`, with no mix-up between ids and rows. → Task 5 test `two positions closing in one poll get their own messages`.
3. **One wallet's historical keeps failing:** another wallet's due closes must still get checked. → Task 5 test `a wallet whose historical keeps failing does not block another wallet's close checks`.
4. **Restart with pending closes:** checks resume from the database at the right time, with no in-memory state needed. → Task 5 test `close schedule survives a restart`.
5. **Upgrade with legacy `miss_count > 0` rows:** they load as normal open rows, and on the next miss they alert CLOSED immediately. → Task 4 test `legacy miss_count rows load as plain open rows`.

---

### Task 1: Notifier — send returns message_id, edit in place

**Files:**
- Modify: `src/notify.ts`
- Modify: `scripts/probe.ts:6,48-69` (use `createTelegramNotifier(...).send`)
- Test: `test/notify.test.ts`

**Interfaces:**
- Produces (in `src/notify.ts`):
  - `export type EditResult = 'ok' | 'gone';`
  - `export interface Notifier { send(html: string): Promise<number>; edit(messageId: number, html: string): Promise<EditResult>; }`
  - `export function sendWithRetry<T>(send: () => Promise<T>, opts?: { attempts?: number; sleep?: (ms: number) => Promise<void> }): Promise<T>` (now returns the value)
  - `export function createTelegramNotifier(api: Api, chatId: number, opts?: { sleep?: (ms: number) => Promise<void> }): Notifier`. This replaces `createTelegramNotify`.

- [ ] **Step 1: Write the failing tests** in `test/notify.test.ts`. Keep the three `sendWithRetry` tests and add:

```ts
it('returns the value of the successful attempt', async () => {
  const send = vi.fn<() => Promise<number>>().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce(5);
  await expect(sendWithRetry(send, { sleep: async () => {} })).resolves.toBe(5);
});
```

Replace the `createTelegramNotify` block with `describe('createTelegramNotifier')`:

```ts
const opts = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } };
const sleep = async (_ms: number) => {};

it('send posts HTML with previews disabled and returns message_id', async () => {
  const sendMessage = vi.fn(async () => ({ message_id: 314 }));
  const n = createTelegramNotifier({ sendMessage } as never, 42, { sleep });
  await expect(n.send('<b>hi</b>')).resolves.toBe(314);
  expect(sendMessage).toHaveBeenCalledWith(42, '<b>hi</b>', opts);
});

it('edit calls editMessageText with the same options', async () => {
  const editMessageText = vi.fn(async () => ({}));
  const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
  await expect(n.edit(7, '<b>x</b>')).resolves.toBe('ok');
  expect(editMessageText).toHaveBeenCalledWith(42, 7, '<b>x</b>', opts);
});

it('edit treats "message is not modified" as ok without retrying', async () => {
  const err = Object.assign(new Error('400'), { description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same' });
  const editMessageText = vi.fn(async () => { throw err; });
  const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
  await expect(n.edit(7, 'x')).resolves.toBe('ok');
  expect(editMessageText).toHaveBeenCalledTimes(1);
});

it('edit returns gone for "message to edit not found" without retrying', async () => {
  const err = Object.assign(new Error('400'), { description: 'Bad Request: message to edit not found' });
  const editMessageText = vi.fn(async () => { throw err; });
  const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
  await expect(n.edit(7, 'x')).resolves.toBe('gone');
  expect(editMessageText).toHaveBeenCalledTimes(1);
});

it('edit rethrows other errors after 3 attempts', async () => {
  const editMessageText = vi.fn(async () => { throw new Error('down'); });
  const n = createTelegramNotifier({ editMessageText } as never, 42, { sleep });
  await expect(n.edit(7, 'x')).rejects.toThrow('down');
  expect(editMessageText).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 2: Run** `npx vitest run test/notify.test.ts`. Expected: FAIL (`createTelegramNotifier` is not exported).

- [ ] **Step 3: Implement** in `src/notify.ts`. Make `sendWithRetry` generic. In `edit`, the attempt function catches the error, reads `description` by shape (like `retryAfterMs` does), and *returns* `'ok'` or `'gone'` for the two known descriptions so they never reach the retry loop. Anything else is rethrown. Move the `Notifier` type here; `notify.ts` stops importing from `poller.js`. Update `scripts/probe.ts` to `const notifier = send ? createTelegramNotifier(...) : null` and `await notifier.send(html)`.

- [ ] **Step 4: Run** `npx vitest run test/notify.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/notify.ts scripts/probe.ts test/notify.test.ts
git commit -m "feat: notifier returns message ids and can edit messages"
```

---

### Task 2: Detector — closes on first miss, false alarms, close matching

**Files:**
- Modify: `src/detector.ts`
- Modify: `test/fixtures/make.ts` (drop `missCount` from `makeRow`; add `makeClose`)
- Test: `test/detector.test.ts`

**Interfaces:**
- Produces (in `src/detector.ts`):
  - `PositionRow` without `missCount`: `{ key; data: OpenPosition; feeBaselineUsd; feeBaselineNative; lastSeenAt }`.
  - `export interface PendingClose { key: string; row: PositionRow; messageId: number; detectedAt: string; attempts: number; nextCheckAt: string }`
  - `AlertEvent`. The `closed` variant becomes `{ type: 'closed'; wallet: WalletRef; row: PositionRow; detectedAt: string }`. New variant: `{ type: 'false_alarm'; wallet: WalletRef; position: OpenPosition; close: PendingClose }`. `opened` and `fee_collected` are unchanged.
  - `export interface DiffResult { events: AlertEvent[]; upserts: PositionRow[]; restores: string[] }`. `deletes` and `hasSuspects` are gone; newly missing rows are the `closed` events.
  - `export function diffOpening(wallet: WalletRef, rows: PositionRow[], pending: PendingClose[], fresh: OpenPosition[], opts: { feeAlertMinUsd: number; baselining: boolean; now: string }): DiffResult`
  - `export const CLOSE_CHECK_OFFSETS_MS = [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 1_800_000, 3_600_000] as const;`
  - `export const CLOSE_GIVE_UP_MS = 3_600_000;`
  - `export function nextCheckAt(detectedAt: string, attempts: number): string`. Returns `detectedAt + CLOSE_CHECK_OFFSETS_MS[min(attempts, last)]` as an ISO string.
  - `export type CloseMatch = { close: PendingClose; kind: 'found'; closed: ClosedPosition } | { close: PendingClose; kind: 'expired' } | { close: PendingClose; kind: 'waiting'; attempts: number; nextCheckAt: string };`
  - `export function matchCloses(due: PendingClose[], historical: ClosedPosition[], now: string): CloseMatch[]`. Results come back in input order. `found` is keyed by `positionKey`, with the first historical item winning. `expired` when not found and `now ≥ detectedAt + CLOSE_GIVE_UP_MS`. Otherwise `waiting`, with `attempts + 1` and `nextCheckAt(detectedAt, attempts + 1)`.
  - `confirmCloses` is deleted.
- Produces (in `test/fixtures/make.ts`): `makeClose(row: PositionRow, overrides?: Partial<PendingClose>): PendingClose`. Defaults are `messageId: 100`, `detectedAt: '2026-10-10T00:00:00.000Z'`, `attempts: 0`, `nextCheckAt: '2026-10-10T00:00:30.000Z'`, and `key: row.key`.

- [ ] **Step 1: Write the failing tests** in `test/detector.test.ts`. Replace `missing position increments missCount and flags suspects` and `reappearing suspect resets missCount silently`, and the whole `confirmCloses` describe:

```ts
it('missing position emits closed with its row and detectedAt', () => {
  const row = makeRow(makePosition({ tokenId: '2' }));
  const r = diffOpening(wallet, [row], [], [], opts);
  expect(r.events).toEqual([{ type: 'closed', wallet, row, detectedAt: NOW }]);
  expect(r.upserts).toEqual([]);
  expect(r.restores).toEqual([]);
});

it('pending close back in fresh emits false_alarm and restores it, no opened', () => {
  const p = makePosition({ tokenId: '2' });
  const close = makeClose(makeRow(p, { feeBaselineUsd: 4, lastSeenAt: '2026-10-09T00:00:00.000Z' }));
  const r = diffOpening(wallet, [], [close], [p], opts);
  expect(r.events).toEqual([{ type: 'false_alarm', wallet, position: p, close }]);
  expect(r.restores).toEqual([close.key]);
  expect(r.upserts).toEqual([{ ...close.row, data: p, lastSeenAt: NOW }]);
});

it('false alarm uses the pending close baselines so a fee collected meanwhile alerts', () => {
  const before = makePosition({ tokenId: '2', collectedFee: 0 });
  const close = makeClose(makeRow(before));
  const after = { ...before, collectedFee: 5, collectedFeeNative: 0.002 };
  const r = diffOpening(wallet, [], [close], [after], { feeAlertMinUsd: 1, baselining: false, now: NOW });
  expect(r.events.map((e) => e.type)).toEqual(['false_alarm', 'fee_collected']);
  expect(r.upserts[0].feeBaselineUsd).toBe(5);
});
```

Add `describe('nextCheckAt')`:

```ts
it('follows the offsets and clamps at 60m', () => {
  const d = '2026-10-10T00:00:00.000Z';
  expect(nextCheckAt(d, 0)).toBe('2026-10-10T00:00:30.000Z');
  expect(nextCheckAt(d, 5)).toBe('2026-10-10T00:15:00.000Z');
  expect(nextCheckAt(d, 7)).toBe('2026-10-10T01:00:00.000Z');
  expect(nextCheckAt(d, 99)).toBe('2026-10-10T01:00:00.000Z');
});
```

Add `describe('matchCloses')` (with `D = '2026-10-10T00:00:00.000Z'` and `at = (ms) => new Date(Date.parse(D) + ms).toISOString()`):
- `found in historical`: `kind: 'found'`, `closed` is the matching item. A same-tokenId item on a different protocol does not match.
- `not found advances attempts and schedule`: attempts 2 at `at(120_000)` gives `{ kind: 'waiting', attempts: 3, nextCheckAt: at(240_000) }`.
- `expired at exactly 60 minutes`: `now = at(3_600_000)` gives `kind: 'expired'`.
- `not expired at 59m59s`: `now = at(3_599_000)` with attempts 7 gives `waiting` with `nextCheckAt: at(3_600_000)`.

- [ ] **Step 2: Run** `npx vitest run test/detector.test.ts`. Expected: FAIL (new exports missing, `diffOpening` arity).

- [ ] **Step 3: Implement** in `src/detector.ts`. In `diffOpening`, build `pendingByKey`. For each fresh key with no stored row but a pending close, use `close.row` as the existing row, run the unchanged fee logic on it, emit `false_alarm` *before* any `fee_collected`, and push the key to `restores`. A stored row missing from `fresh` emits `closed` and produces no upsert. Drop all `missCount` handling. Update `makeRow`, add `makeClose`, and remove `missCount` from the other `detector.test.ts` expectations.

- [ ] **Step 4: Run** `npx vitest run test/detector.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/detector.ts test/detector.test.ts test/fixtures/make.ts
git commit -m "feat: detect closes on first miss and false alarms; match pending closes"
```

---

### Task 3: Format — one function for every close state

**Files:**
- Modify: `src/format.ts:173-189`
- Test: `test/format.test.ts:192-279`

**Interfaces:**
- Consumes: the `AlertEvent` variants from Task 2.
- Produces (in `src/format.ts`):
  - `export type CloseState = { kind: 'pending'; detectedAt: string } | { kind: 'final'; closed: ClosedPosition } | { kind: 'unavailable'; detectedAt: string } | { kind: 'false_alarm' };`
  - `export function formatClosed(wallet: WalletRef, position: OpenPosition, state: CloseState): string`
  - `formatEvent`: `closed` → `formatClosed(e.wallet, e.row.data, { kind: 'pending', detectedAt: e.detectedAt })`; `false_alarm` → `formatClosed(e.wallet, e.position, { kind: 'false_alarm' })`.

- [ ] **Step 1: Write the failing tests.** Convert the existing closed tests to `formatClosed`: `closed with pnl` → `{kind:'final', closed}` (keep its inline snapshot), `closed with negative pnl` and `zero historical fees falls back` the same way, `closed forced` → `{kind:'unavailable', detectedAt: closedAt}`, and the clock-skew test → `unavailable` with `detectedAt: '2026-09-01T00:00:00.000Z'`. Add:

```ts
it('closed pending', () => {
  const out = formatClosed(wallet, position, { kind: 'pending', detectedAt: closedAt });
  expect(out).toMatchInlineSnapshot(`
    "<b>🔴 CLOSED · whale</b>
    WETH/USDG · Uniswap V3
    Held: 3d 4h
    PnL: pending…
    Fees earned: $99.00
    Position #1 · Wallet <a href="https://app.lpagent.io/portfolio?address=0x12ab340000000000000000000000000000009f3c&amp;chain=ROBINHOOD">0x12ab…9f3c</a>"
  `);
});

it('false alarm', () => {
  const out = formatClosed(wallet, position, { kind: 'false_alarm' });
  expect(out).toMatchInlineSnapshot(`
    "<b>⚪ FALSE ALARM · whale</b>
    WETH/USDG · Uniswap V3
    Position is still open.
    Position #1 · Wallet <a href="https://app.lpagent.io/portfolio?address=0x12ab340000000000000000000000000000009f3c&amp;chain=ROBINHOOD">0x12ab…9f3c</a>"
  `);
});

it('formatEvent closed renders the pending state', () => {
  const out = formatEvent({ type: 'closed', wallet, row: makeRow(position), detectedAt: closedAt });
  expect(out).toContain('PnL: pending…');
});

it('formatEvent false_alarm renders the false alarm', () => {
  const close = makeClose(makeRow(position));
  expect(formatEvent({ type: 'false_alarm', wallet, position, close })).toContain('FALSE ALARM');
});
```

Update `escapes html in label and symbol` and `name falls back to short address` if they build `closed` events.

- [ ] **Step 2: Run** `npx vitest run test/format.test.ts`. Expected: FAIL (`formatClosed` is not exported).

- [ ] **Step 3: Implement `formatClosed`.** Held: `final` uses `closed.createdAt → closed.closeAt`; `pending` and `unavailable` use `position.createdAt → detectedAt`. PnL: `final` with both values non-null uses `signedUsd (signedPct)`, otherwise `unavailable`; `pending` is `pending…`. Fees: `final` uses `closed.collectedFee > 0 ? closed.collectedFee : position.collectedFee`, everything else uses `position.collectedFee`.

- [ ] **Step 4: Run** `npx vitest run test/format.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "feat: format pending, final, unavailable and false-alarm close messages"
```

---

### Task 4: DB — closes table

**Files:**
- Modify: `src/db.ts`
- Test: `test/db.test.ts`

**Interfaces:**
- Consumes: `PositionRow` and `PendingClose` from Task 2.
- Produces (in `src/db.ts`):
  - Schema: the `closes` table exactly as in spec §4, created with `CREATE TABLE IF NOT EXISTS`.
  - `export interface NewClose { row: PositionRow; messageId: number; detectedAt: string; nextCheckAt: string }`
  - `PollResultInput` becomes `{ upserts: PositionRow[]; closes?: NewClose[]; restores?: string[]; markBaselined?: boolean; polledAt?: string }`. `deletes` is removed. `closes` inserts each row with `attempts = 0` and deletes the matching `positions` row; `restores` deletes those `closes` rows. Everything happens in the existing transaction.
  - `Db` gains:
    - `getCloses(address: string): PendingClose[]`, ordered by rowid.
    - `dueCloseWallets(now: string): string[]`: wallets with any `next_check_at ≤ now`, ordered by their `MIN(next_check_at)`, then `w.added_at, w.rowid`.
    - `countCloses(): number`
    - `applyCloseResult(address: string, r: { updates: { key: string; attempts: number; nextCheckAt: string }[]; deletes: string[] }): void`. Transactional, and a no-op for an unknown wallet.
  - `walletsWithSuspects` is removed. `upsertPosition` writes `miss_count = 0`.

- [ ] **Step 1: Write the failing tests** in `test/db.test.ts`. Adapt `applyPollResult upserts, deletes, marks baselined` (drop deletes) and replace `walletsWithSuspects`:
  - `applyPollResult moves closes out of positions`: seed rows 1 and 2, then apply `closes: [{ row: row2, messageId: 7, detectedAt: D, nextCheckAt: D30 }]`. `getPositions` keys equal `['uniswap_v3:1']`. `getCloses(A)` equals `[{ key: row2.key, row: row2, messageId: 7, detectedAt: D, attempts: 0, nextCheckAt: D30 }]` (deep equal, so `row_json` round-trips).
  - `applyPollResult restores move a close back`: apply `upserts: [row2], restores: [row2.key]`. Closes are empty and positions include row2.
  - `applyCloseResult updates and deletes`: attempts and nextCheckAt are updated on one close and the other is deleted.
  - `dueCloseWallets orders by earliest due and excludes future ones`: A due at 00:01, B due at 00:00:30, C due at 02:00, and `now = 00:05` gives `[B, A]`.
  - `countCloses counts across wallets`.
  - `removeWallet cascades closes`.
  - `legacy miss_count rows load as plain open rows`: insert a row via raw SQL with `miss_count = 2` on a file DB, reopen it with `openDb`, and check `getPositions` returns it with no `missCount` property (`expect('missCount' in row).toBe(false)`).

- [ ] **Step 2: Run** `npx vitest run test/db.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `row_json` stores `JSON.stringify(row)`, and reads parse it back as `PositionRow`.

- [ ] **Step 4: Run** `npx vitest run test/db.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "feat: closes table for alerted closes awaiting stats"
```

---

### Task 5: Poller — immediate CLOSED, close checks, edits

**Files:**
- Modify: `src/poller.ts`
- Modify: `src/index.ts:6,35-36` (`createTelegramNotifier`, pass `notifier`)
- Modify: `src/commands.ts:62` (`Pending closes: ${s.pendingCloses}`)
- Test: `test/poller.test.ts`, `test/commands.test.ts:20` (`pendingCloses: 1`, and the expected `Pending closes: 1` line)

**Interfaces:**
- Consumes: `Notifier` / `EditResult` (Task 1); `diffOpening`, `matchCloses`, `nextCheckAt`, `PendingClose` (Task 2); `formatClosed`, `formatEvent` (Task 3); `NewClose` and the new `Db` methods (Task 4).
- Produces:
  - `createPoller(deps: { db; client; notifier: Notifier; logger; config: Pick<Config, 'rpmLimit' | 'feeAlertMinUsd'>; now? })`. The `Notify` type is removed from `poller.ts`.
  - `PollerStatus.pendingCloses: number` (from `db.countCloses()`), replacing `pendingConfirms`.
  - `const EDIT_RETRY_MS = 300_000; const EDIT_GIVE_UP_MS = 7_200_000;`

Behaviour (spec §5.5 plus the Global Constraints):
- **Opening poll:** call `diffOpening` with `db.getCloses(address)`. Send events in order. For each `closed`, keep the returned id and build `NewClose { row, messageId, detectedAt, nextCheckAt: nextCheckAt(detectedAt, 0) }`. For each `false_alarm`, call `notifier.edit(close.messageId, formatEvent(e))`. Any rejection means the poll isn't committed (existing path). Otherwise commit `{ upserts, closes, restores, markBaselined, polledAt }`.
- **Close-check poll:** for the chosen wallet, `due = getCloses(a).filter(c => c.nextCheckAt <= now)`, and `from = min(due.row.lastSeenAt) − 1h` (keep `HISTORICAL_LOOKBACK_MS`). On a historical error: `onApiError`, set `lastFailedCheck = address`, commit nothing. On success: `matchCloses`, then `found` → edit `final`, `expired` → edit `unavailable` (both delete on `'ok'` or `'gone'`), and `waiting` → update. An edit rejection follows the Global Constraints rule. Commit with one `applyCloseResult`. Clear `lastFailedCheck` if it was this wallet and nothing was rejected.
- **Tick:** `due = db.dueCloseWallets(nowIso)`; `pick = due.find(a => a !== lastFailedCheck) ?? due[0]`. If `pick` exists and not `(lastTickWasConfirm && wallet)`, run the close check and return. Otherwise run the opening poll. The no-request fall-through (`confirmPoll` returning false) is no longer needed and is removed.

- [ ] **Step 1: Rewrite the test harness.** In `setup()`, replace `notify` with a recording notifier: `sent: string[]` (ids start at 100, so `send` returns `100 + index`), `edits: { id: number; html: string }[]`, and state flags `failNext`, `failWhen`, `editFail: boolean`, `editGone: boolean`. Drop `closeMissLimit`. Add a `seedClose(db, row, overrides)` helper that seeds a baselined row and moves it with `applyPollResult(A, { upserts: [], closes: [...] })` after upserting it.

- [ ] **Step 2: Write the failing tests.** Delete these tests: `missing position triggers historical confirm next tick`, `forced close after miss limit`, `telegram failure on a close keeps the wallet pending`, `a failing historical call keeps the wallet pending`, `forced close still happens while historical keeps failing`, `a confirm tick with no suspects left polls opening in the same tick`, `a confirm tick for a removed wallet polls opening in the same tick`, `a failing confirm moves to the back so the next confirm tick processes the other wallet`. Rename `invalid response does not increment miss counts` → `invalid response closes nothing` (asserting `sent` is empty and `countCloses() === 0`). Adapt `a wallet whose historical keeps failing does not starve opening polls` to seeded closes. Swap `pendingConfirms` for `pendingCloses` everywhere. Add (`T(ms)` = ISO of `T0 + ms`):
  - `missing position sends CLOSED immediately with PnL pending`: seed p1 and p2, opening `[p1]`, one tick. `sent` has one message containing `CLOSED` and `PnL: pending…`; position keys equal `['uniswap_v3:1']`; `getCloses(A)` has `{ key: 'uniswap_v3:2', messageId: 100, attempts: 0, nextCheckAt: T(30_000) }`; `pendingCloses === 1`.
  - `two positions closing in one poll get their own messages`: two `CLOSED` messages; close for key 2 → id 100, key 3 → id 101.
  - `a close that is not due yet leaves the tick to opening polls`: at T0 after the close, the next tick makes one opening call and zero historical calls.
  - `edits the CLOSED message with final stats when historical has it`: clock `T0+30s`, historical `[closedOf(p2)]`. `historicalCalls[0].from` equals `SEEN − 1h`; `edits` equals `[{ id: 100, html: expect.stringContaining('PnL: +$12.50') }]`; closes are empty; no new `sent`.
  - `not yet in historical advances the schedule`: clock `T0+30s`, historical `[]`. Attempts 1, `nextCheckAt: T(60_000)`, no edits.
  - `gives up at 60 minutes with PnL unavailable`: close seeded with attempts 7 and `nextCheckAt: T(3_600_000)`, clock `T0+60m`, historical `[]`. The edit contains `PnL: unavailable` and closes are empty.
  - `historical failure never expires a close`: same seed at `T0+61m`, historical `Error`. Close unchanged, no edits.
  - `deleted message drops the close`: `editGone = true`, found. Closes empty, no error recorded.
  - `edit failure on a close check retries in 5 minutes`: `editFail = true`, found at `T0+30s`. Close kept with attempts 0, `nextCheckAt = T(30_000 + 300_000)`, and `status().lastSendError` is set.
  - `edit failure past 2 hours drops the close`: `editFail`, clock `T0+2h`, found. Closes empty.
  - `reappearing position while pending edits FALSE ALARM and restores it without OPENED`: after the close, opening `[p1, p2]`. `sent` has no new message; `edits` equals `[{ id: 100, html: expect.stringContaining('FALSE ALARM') }]`; positions include key 2; closes are empty.
  - `false-alarm edit failure commits nothing`: `editFail` during that poll. Close still pending, key 2 not in positions.
  - `CLOSED send failure commits nothing and the next poll resends`: `failNext`. Positions still has 2 rows and closes is empty; the next opening tick sends `CLOSED`.
  - `reappearing after the close is finalized alerts OPENED`: after the final edit, opening `[p1, p2]` sends `OPENED`.
  - `close schedule survives a restart`: seed a close directly in the DB before `createPoller`, clock `T0+30s`. The first tick is a historical call.
  - `close checks never take two ticks in a row while a wallet exists`: wallets A and B, both with due closes and historical always `[]` with closes far from expiry. Four ticks give the call order check, opening, check, opening.
  - `a wallet whose historical keeps failing does not block another wallet's close checks`: A and B both due (A earlier); historical throws for A and returns `[]` for B. Advance the clock past the backoff between ticks; the second historical call's owner is B.

- [ ] **Step 3: Run** `npx vitest run test/poller.test.ts test/commands.test.ts`. Expected: FAIL.

- [ ] **Step 4: Implement** per the behaviour block above. Wire up `src/index.ts` and `src/commands.ts`.

- [ ] **Step 5: Run** `npx vitest run test/poller.test.ts test/commands.test.ts` and `npm run typecheck`. Expected: PASS. Typecheck may still complain only about `config.ts` / `closeMissLimit` (handled in Task 6).

- [ ] **Step 6: Commit**

```bash
git add src/poller.ts src/index.ts src/commands.ts test/poller.test.ts test/commands.test.ts
git commit -m "feat: send CLOSED on first miss and edit it with stats from close checks"
```

---

### Task 6: Remove CLOSE_MISS_LIMIT, docs, full verification

**Files:**
- Modify: `src/config.ts:9,23,40`, `.env.example:6`, `README.md:35` (and any README text describing the 3-poll close confirmation)
- Test: `test/config.test.ts:18,33,38`

- [ ] **Step 1: Write the failing test** in `test/config.test.ts`. Remove the `closeMissLimit` expectations and add:

```ts
it('ignores a leftover CLOSE_MISS_LIMIT', () => {
  const c = loadConfig({ ...REQUIRED, CLOSE_MISS_LIMIT: '3' });
  expect('closeMissLimit' in c).toBe(false);
});
```

(`REQUIRED` here is whatever minimal env object the file already uses.)

- [ ] **Step 2: Run** `npx vitest run test/config.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** Remove the field, the env key and the README row. Rewrite the README's close-alert description so it says: a CLOSED alert is sent as soon as a position disappears, then edited with PnL when available (or "unavailable" after 1h, or "false alarm" if it reappears).

- [ ] **Step 4: Run everything:** `npm test` and `npm run typecheck`. Expected: all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example README.md test/config.test.ts
git commit -m "chore: drop CLOSE_MISS_LIMIT now that closes alert on first miss"
```
