import pino from 'pino';
import { BOT_COMMANDS, createBot } from './bot.js';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createLpAgentClient } from './lpagent/client.js';
import { createTelegramNotify } from './notify.js';
import { createPoller } from './poller.js';

const logger = pino({ level: 'info' });

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });

  const db = openDb(config.dbPath);
  const client = createLpAgentClient({ apiKey: config.lpagentApiKey });
  const bot = createBot({
    token: config.telegramBotToken,
    ownerId: config.telegramOwnerId,
    db,
    getStatus: () => poller.status(),
  });
  const notify = createTelegramNotify(bot.api, config.telegramOwnerId);
  const poller = createPoller({ db, client, notify, logger, config });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    let code = 0;
    try {
      await poller.stop();
      await bot.stop();
      db.close();
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      code = 1;
    }
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  bot.catch((err) => {
    logger.error({ err: err.error, updateId: err.ctx?.update?.update_id }, 'bot handler error');
  });

  try {
    await bot.api.setMyCommands(BOT_COMMANDS);
  } catch (err) {
    logger.error({ err }, 'setMyCommands failed; continuing');
  }

  logger.info(
    { wallets: db.listWallets().length, pollIntervalSeconds: 60 / config.rpmLimit },
    'lp-wallet-tracker starting',
  );

  poller.start();
  bot.start({ drop_pending_updates: true }).catch((err: unknown) => {
    if (shuttingDown) return;
    logger.error({ err }, 'bot stopped unexpectedly');
    process.exit(1);
  });
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});
