# Instant Close Alerts — Design

Date: 2026-10-18
Status: Approved in brainstorming, pending spec review

## 1. Problem

A CLOSED alert waits until a position has been missing from `/lp-positions/opening` for `CLOSE_MISS_LIMIT` (3) polls, checking `/lp-positions/historical` after each miss. The opening list drops a closed position within seconds, but the historical list takes several minutes to index it. With a few wallets, the three misses take only ~2 minutes, so the tracker usually gives up first and sends `PnL: unavailable`, with "Held" measured to the give-up time and "Fees earned" taken from the last open snapshot (often $0.00).

Example: position `…-3870606` closed at 14:29:59 and was force-closed around 14:32. A later historical query had it with PnL +$3.20 (+2.1%) and fees $4.34.

## 2. Goal

- Send the CLOSED alert **the first time** a position is missing from the opening list.
- **Edit that same Telegram message** once historical has the record: real Held time, PnL and fees.
- Give up after **1 hour** and edit the message to `PnL: unavailable`.
- Edits are silent: no extra message, no extra notification.

### Changed success criterion

The original design promised "no false closed alerts caused by API glitches". That's replaced with: **a false close is corrected in place**. If a position that was alerted as closed shows up in the opening list again while its close is still pending, the alert is edited to a false-alarm notice and the position goes back to being tracked as open, with no new OPENED alert.

### Out of scope

- Notifying on the edit (reply or ping).
- Correcting messages for wallets removed while a close is pending; those messages stay at `PnL: pending…`.
- Anything to do with opened or fee-collected alerts.

## 3. Lifecycle

```
open (positions) ──missing from /opening──▶ pending close (closes)  [send CLOSED · PnL: pending…]
pending close ──found in /historical──▶ done                       [edit: final stats]
pending close ──deadline (60 min) passed, still not found──▶ done   [edit: PnL unavailable]
pending close ──back in /opening──▶ open (positions)                [edit: FALSE ALARM]
```

"Done" means the `closes` row is deleted. A position seen again after that is a new OPENED, as today.

## 4. Data

New table. `positions.miss_count` stops being used: it's always written as 0 and kept in the schema so old databases open unchanged.

```sql
CREATE TABLE IF NOT EXISTS closes (
  wallet        TEXT NOT NULL REFERENCES wallets(address) ON DELETE CASCADE,
  position_key  TEXT NOT NULL,
  row_json      TEXT NOT NULL,   -- the full PositionRow (data + fee baselines) at detection
  message_id    INTEGER NOT NULL,
  detected_at   TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT NOT NULL,
  PRIMARY KEY (wallet, position_key)
);
```

`row_json` keeps everything needed to restore the position exactly on a false alarm, and to format every message state without other lookups.

**Upgrade:** existing `positions` rows with `miss_count > 0` need no migration. On their next poll they're still missing, so they go through the new path and get an immediate CLOSED alert.

## 5. Components

### 5.1 Notifier (`notify.ts`)

```ts
export interface Notifier {
  send(html: string): Promise<number>;            // resolves to the Telegram message_id
  edit(messageId: number, html: string): Promise<EditResult>;
}
type EditResult = 'ok' | 'gone';
```

- `send` works as today (retry with flood-control backoff) and returns `message_id`.
- `edit` calls `editMessageText` with the same options and retry.
  - The Telegram error *"message is not modified"* counts as `'ok'`.
  - *"message to edit not found"* returns `'gone'` (the owner deleted the message): the close is dropped without further edits.
  - Any other failure rejects, and the caller retries later.
- Non-event messages (baselined, API down/recovered) use `send` and ignore the id.

### 5.2 Detector (`detector.ts`)

`diffOpening(wallet, rows, pendingCloses, fresh, opts)`:

- A stored row missing from `fresh` gives a `closed` event, plus a `newCloses` entry `{ row, detectedAt: now }`. There are no more suspects or miss counts.
- A `fresh` position whose key is in `pendingCloses` gives a `false_alarm` event, plus a `restores` entry. The pending close's stored row is used as the existing row, so the normal fee check runs against its saved baselines in the same diff, and a fee collected meanwhile still alerts. It never produces an OPENED event.
- Opened and fee logic is unchanged.

`matchCloses(pending, historical, now)` replaces `confirmCloses`:

- A pending close found in historical (matched by `positionKey`) is `found`, with its `ClosedPosition`.
- A pending close not found whose `detectedAt + 60 min ≤ now` is `expired`.
- Any other pending close is `waiting`, and its next check time comes from the schedule (§5.4).

Both stay pure.

### 5.3 Formatting (`format.ts`)

One function for every close state, used both for the first send and for edits:

```ts
formatClosed(wallet, position, state)
state = { kind: 'pending', detectedAt }
      | { kind: 'final', closed: ClosedPosition }
      | { kind: 'unavailable', detectedAt }
      | { kind: 'false_alarm' }
```

| State | Header | Held | PnL | Fees earned |
|---|---|---|---|---|
| pending | `🔴 CLOSED` | createdAt → detectedAt | `pending…` | last snapshot |
| final | `🔴 CLOSED` | closed.createdAt → closed.closeAt | `+$3.20 (+2.1%)` | closed.collectedFee, or the snapshot if that's 0 (current rule) |
| unavailable | `🔴 CLOSED` | createdAt → detectedAt | `unavailable` | last snapshot |
| false_alarm | `⚪ FALSE ALARM` | — | — | — |

The false-alarm body is the pair/protocol line, `Position is still open.`, and the position line.

### 5.4 Check schedule

Close checks for a pending close run at these offsets from `detected_at`: **30s, 1m, 2m, 4m, 8m, 15m, 30m, 60m**. `next_check_at = detected_at + offsets[attempts]`, and `attempts` goes up after each *successful* historical response that doesn't contain the position. The 60m check is the last: if it doesn't find the position, the close is `expired`.

If a `/historical` request fails, nothing advances. The close stays due, and the poller's existing API backoff limits retries. A close only expires after a successful response, so an API outage never turns into `unavailable` messages; those closes stay pending until LP Agent answers.

### 5.5 Poller (`poller.ts`)

**Opening poll.** As today, plus:

1. For each `closed` event: `send(formatClosed(..pending..))`, collecting the message id.
2. For each `false_alarm` event: `edit(messageId, formatClosed(..false_alarm..))`. A `'gone'` result is fine.
3. If any send or edit rejects, nothing is committed (as today) and the wallet is retried on its next turn.
4. One transaction applies the upserts, moves `newCloses` from `positions` to `closes` (with `attempts = 0` and `next_check_at = detected_at + 30s`), and moves `restores` from `closes` back to `positions`.

**Close-check poll** (replaces the confirm poll). It picks the wallet whose earliest `next_check_at ≤ now` is oldest, and makes one `/historical` call with `from = min(row.lastSeenAt) − 1h` over that wallet's due closes. Then:

- `found` → `edit(final)`.
- `expired` → `edit(unavailable)`.
- `waiting` → only the schedule is updated.
- An edit that returns `'gone'` deletes the close.
- An edit that rejects leaves that close untouched, so it's due again and retried. The others are still committed.

Each close commits on its own, so one stuck edit can't hold back the rest.

**Tick.** Same rule as today: a due close check takes priority, but never on two ticks in a row while a wallet exists to poll. The in-memory `pendingConfirm` set is gone: due work comes from `closes.next_check_at`, so it survives restarts.

**Status.** `pendingConfirms` becomes `pendingCloses` (the row count of `closes`), and `/status` shows `Pending closes: N`.

### 5.6 Config

`CLOSE_MISS_LIMIT` is removed from `config.ts`, `.env.example` and the README. An old `.env` that still sets it is ignored, not rejected.

## 6. Failure cases

| Case | Behaviour |
|---|---|
| CLOSED send fails | Poll not committed. The position is still in `positions`, so it's detected again next turn. |
| Crash between send and commit | Same as above, so a duplicate CLOSED is possible: the same at-least-once delivery as today. |
| Edit fails during a close check | That close keeps its attempts and is retried every 5 min. If it's still failing 2 h after detection, the close is dropped and an error is logged. |
| Owner deleted the message | `'gone'` → close dropped silently. |
| `/historical` down | Nothing expires. API-down alert as today. Closes resume when it recovers. |
| Position reappears after the close is finalized | Treated as a new OPENED. |
| Wallet removed with closes pending | `ON DELETE CASCADE` removes them. Messages stay at `pending…`. |

## 7. Request budget

About 8 historical requests per close, spread over an hour, and one request covers all of a wallet's due closes. That's against 5 RPM shared with opening polls. Because close checks can never take two ticks in a row, opening polls get at least half of the ticks.

## 8. Testing

- **detector:** missing → close; reappear while pending → false alarm with the preserved baselines and no OPENED; `matchCloses` found / waiting (schedule) / expired at exactly 60m.
- **format:** all four states, including Held, fees fallback, and HTML escaping.
- **notify:** `send` returns message_id; `edit` maps "not modified" to ok and "not found" to gone, and retries flood control.
- **db:** move to `closes` and back, cascade on wallet removal, due query ordering, `row_json` round-trip.
- **poller** (fake client + recording notifier): immediate CLOSED on first miss; edit to final when historical catches up a few checks later; edit to unavailable at 60m; false alarm; send failure not committed; edit failure retried; gone dropped; historical failure never expires; schedule survives a restart; close checks never take two ticks in a row.
