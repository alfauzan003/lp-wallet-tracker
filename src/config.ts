import { z } from "zod";

export interface Config {
  telegramBotToken: string;
  telegramOwnerId: number;
  lpagentApiKey: string;
  rpmLimit: number;
  feeAlertMinUsd: number;
  dbPath: string;
}

/** An empty or whitespace-only value counts as unset, so the default applies. */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive(),
  LPAGENT_API_KEY: z.string().min(1),
  RPM_LIMIT: optional(z.coerce.number().int().positive().default(5)),
  FEE_ALERT_MIN_USD: optional(z.coerce.number().nonnegative().default(1)),
  DB_PATH: optional(z.string().min(1).default("./data/tracker.db")),
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
    dbPath: e.DB_PATH,
  };
}
