# LP Wallet Tracker

A single-owner Telegram bot that watches liquidity-provider wallets on Robinhood Chain (via the [LP Agent](https://portal.lpagent.io/) API) and sends alerts to your private chat.

## What it does

Alerts, sent only to the owner's private chat:

- **OPENED**: a tracked wallet opened a new LP position.
- **FEES COLLECTED**: a position accumulated at least `FEE_ALERT_MIN_USD` (default $1) of newly collected fees.
- **CLOSED**: a position was closed (confirmed against LP Agent's history, with PnL and fees earned).

Commands (the bot ignores everyone except the owner):

| Command | Description |
| --- | --- |
| `/add <address> [label]` | Start tracking a wallet, optionally with a label |
| `/remove <address or label>` | Stop tracking a wallet |
| `/list` | List tracked wallets |
| `/status` | Uptime, poll cycle, and API health |

The LP Agent API does not return transaction hashes, so alerts link to the wallet's LP Agent portfolio instead.

## Configuration

Environment variables (see `.env.example`):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | yes | | Bot token from BotFather |
| `TELEGRAM_OWNER_ID` | yes | | Your numeric Telegram user ID |
| `LPAGENT_API_KEY` | yes | | LP Agent API key |
| `RPM_LIMIT` | no | `5` | Max LP Agent requests per minute |
| `FEE_ALERT_MIN_USD` | no | `1` | Minimum accumulated fees (USD) before a fee alert |
| `CLOSE_MISS_LIMIT` | no | `3` | Consecutive polls a position must be missing before a close is confirmed |
| `DB_PATH` | no | `./data/tracker.db` | SQLite database file |

## Getting the credentials

1. **Bot token**: message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the prompts. Copy the token.
2. **Your numeric ID**: message [@userinfobot](https://t.me/userinfobot); it replies with your ID.
3. **LP Agent key**: create one at <https://portal.lpagent.io/>.

## Run locally

```sh
cp .env.example .env      # then fill in the three required values
npm ci
npm test
npm run probe -- <wallet address>   # optional live check against the API
npm run dev
```

`npm run probe -- <address> [--send]` fetches the wallet's open positions and last 30 days of closed positions, saves the raw responses under `data/` (gitignored), and prints what the bot would alert on. With `--send` it also delivers the formatted OPENED messages to you.

## Deploy to a VPS (Ubuntu/Debian)

```sh
# Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

# Service user and checkout
sudo useradd --system --create-home --home-dir /opt/lp-tracker --shell /usr/sbin/nologin lptracker
sudo git clone <your-repo-url> /opt/lp-tracker
sudo chown -R lptracker:lptracker /opt/lp-tracker

# Build (npm ci needs dev dependencies because tsc builds the project)
cd /opt/lp-tracker
sudo -u lptracker npm ci
sudo -u lptracker npm run build

# Configuration
sudo -u lptracker cp .env.example .env
sudo -u lptracker nano .env
sudo chmod 600 .env

# systemd
sudo cp deploy/lp-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now lp-tracker
```

`better-sqlite3` downloads a prebuilt binary during `npm ci`. If that fails, install a toolchain and retry:

```sh
sudo apt-get install -y build-essential python3
```

### Logs

```sh
journalctl -u lp-tracker -f
```

### Updating

```sh
cd /opt/lp-tracker
sudo -u lptracker git pull && sudo -u lptracker npm ci && sudo -u lptracker npm run build && sudo systemctl restart lp-tracker
```

### Backup

All state lives in one SQLite file, `data/tracker.db` (under `/opt/lp-tracker` by default). The database runs in WAL mode, so stop the service (`sudo systemctl stop lp-tracker`) before copying it, and copy any `tracker.db-wal` and `tracker.db-shm` files alongside it if present.

## Polling and limitations

- On the LP Agent Basic plan (5 requests per minute) the bot makes one request every 12 seconds, so each wallet is checked about every (number of wallets x 12 s). Ten wallets means roughly two minutes between checks of the same wallet.
- A position opened and closed entirely between two polls of its wallet is not reported.
- The first poll of a newly added wallet records its existing positions silently (you get one "Tracking ..." message); only later changes alert.
