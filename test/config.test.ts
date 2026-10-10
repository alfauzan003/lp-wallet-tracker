import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const required = {
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_OWNER_ID: "12345",
  LPAGENT_API_KEY: "key",
};

describe("loadConfig", () => {
  it("parses required vars and applies defaults", () => {
    const c = loadConfig(required);
    expect(c.telegramBotToken).toBe("123:abc");
    expect(c.lpagentApiKey).toBe("key");
    expect(c.telegramOwnerId).toBe(12345);
    expect(c.rpmLimit).toBe(5);
    expect(c.feeAlertMinUsd).toBe(1);
    expect(c.closeMissLimit).toBe(3);
    expect(c.dbPath).toBe("./data/tracker.db");
  });

  it("overrides defaults", () => {
    const c = loadConfig({ ...required, RPM_LIMIT: "10", FEE_ALERT_MIN_USD: "2.5" });
    expect(c.rpmLimit).toBe(10);
    expect(c.feeAlertMinUsd).toBe(2.5);
  });

  it("treats blank optional vars as unset", () => {
    const c = loadConfig({
      ...required,
      RPM_LIMIT: "",
      FEE_ALERT_MIN_USD: "  ",
      CLOSE_MISS_LIMIT: "",
      DB_PATH: " ",
    });
    expect(c.rpmLimit).toBe(5);
    expect(c.feeAlertMinUsd).toBe(1);
    expect(c.closeMissLimit).toBe(3);
    expect(c.dbPath).toBe("./data/tracker.db");
  });

  it("accepts FEE_ALERT_MIN_USD=0", () => {
    expect(loadConfig({ ...required, FEE_ALERT_MIN_USD: "0" }).feeAlertMinUsd).toBe(0);
  });

  it("throws naming missing vars", () => {
    expect(() => loadConfig({})).toThrow(/TELEGRAM_BOT_TOKEN/);
    expect(() => loadConfig({})).toThrow(/TELEGRAM_OWNER_ID/);
    expect(() => loadConfig({})).toThrow(/LPAGENT_API_KEY/);
  });

  it("rejects non-numeric owner id", () => {
    expect(() => loadConfig({ ...required, TELEGRAM_OWNER_ID: "abc" })).toThrow();
  });
});
