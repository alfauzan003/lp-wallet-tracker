import { Bot } from 'grammy';
import { cmdAdd, cmdList, cmdRemove, cmdStatus } from './commands.js';
import type { Db } from './db.js';
import type { PollerStatus } from './poller.js';

export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'add', description: 'Track a wallet: /add <0x address> [label]' },
  { command: 'remove', description: 'Stop tracking: /remove <address or label>' },
  { command: 'list', description: 'List tracked wallets' },
  { command: 'status', description: 'Bot uptime and health' },
];

const REPLY_OPTS = {
  parse_mode: 'HTML',
  link_preview_options: { is_disabled: true },
} as const;

export function createBot(opts: {
  token: string;
  ownerId: number;
  db: Db;
  getStatus: () => PollerStatus;
}): Bot {
  const { token, ownerId, db, getStatus } = opts;
  const bot = new Bot(token);

  // Owner-only: anything else (including updates with no sender) is dropped silently.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== ownerId) return;
    await next();
  });

  const args = (match: unknown): string => (typeof match === 'string' ? match : '');

  bot.command('add', (ctx) => ctx.reply(cmdAdd(db, args(ctx.match), new Date()), REPLY_OPTS));
  bot.command('remove', (ctx) => ctx.reply(cmdRemove(db, args(ctx.match)), REPLY_OPTS));
  bot.command('list', (ctx) => ctx.reply(cmdList(db, new Date()), REPLY_OPTS));
  bot.command('status', (ctx) => ctx.reply(cmdStatus(getStatus(), new Date()), REPLY_OPTS));

  return bot;
}
