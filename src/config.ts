import { z } from "zod";

export interface Config {
  telegramBotToken: string;
  telegramOwnerId: number;
  lpagentApiKey: string;
  rpmLimit: number;
  feeAlertMinUsd: number;
  closeMissLimit: number;
  dbPath: string;
}

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  LPAGENT_API_KEY: z.string().min(1),
  RPM_LIMIT: z.coerce.number().int().positive().default(5),
  FEE_ALERT_MIN_USD: z.coerce.number().nonnegative().default(1),
  CLOSE_MISS_LIMIT: z.coerce.number().int().positive().default(3),
  DB_PATH: z.string().min(1).default("./data/tracker.db"),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const names = result.error.issues.map((i) => i.path.join("."));
    throw new Error("Invalid config: " + [...new Set(names)].join(", "));
  }
  const e = result.data;
  return {
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramOwnerId: e.TELEGRAM_OWNER_ID,
    lpagentApiKey: e.LPAGENT_API_KEY,
    rpmLimit: e.RPM_LIMIT,
    feeAlertMinUsd: e.FEE_ALERT_MIN_USD,
    closeMissLimit: e.CLOSE_MISS_LIMIT,
    dbPath: e.DB_PATH,
  };
}
