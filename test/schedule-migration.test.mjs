import assert from "node:assert/strict";
import { test, after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DB_PATH = ":memory:";
process.env.DISCORD_TOKEN = "test";
process.env.CLIENT_ID = "test";
const { BotDatabase, db: singleton } = await import("../dist/db.js");
const { weeklyPeriod } = await import("../dist/historySchedule.js");
after(() => singleton.close());

test("weekly schedule migrates the old default to noon UTC once and preserves custom settings", () => {
  const directory = mkdtempSync(join(tmpdir(), "of-noon-schedule-")), filename = join(directory, "bot.db");
  let opened;
  try {
    const legacy = new DatabaseSync(filename);
    legacy.exec(`CREATE TABLE history_settings (
      guild_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,clan_history_enabled INTEGER,player_history_enabled INTEGER,
      collection_enabled INTEGER,weekly_enabled INTEGER,channel_id TEXT,poll_minutes INTEGER,retention_days INTEGER,
      weekly_day INTEGER,weekly_hour INTEGER,timezone TEXT,weekly_since TEXT);
      INSERT INTO history_settings VALUES('default',1,1,1,1,1,'123',15,90,1,9,'America/Bahia','2026-01-01T00:00:00.000Z');
      INSERT INTO history_settings VALUES('custom',2,1,1,1,1,'123',15,90,4,17,'Europe/London','2026-01-01T00:00:00.000Z');`);
    legacy.close();
    opened = new BotDatabase(filename);
    const migrated = opened.history.getSettings("default"), custom = opened.history.getSettings("custom");
    assert.equal(migrated.weekly_hour, 12); assert.equal(migrated.timezone, "UTC");
    assert.equal(migrated.revision, 2);
    assert.ok(Date.parse(opened.history.getWeeklyEnabledAt("default")) > Date.parse("2026-01-01T00:00:00.000Z"), "migration must restart delivery eligibility with a usable timestamp");
    assert.equal(custom.weekly_hour, 17); assert.equal(custom.timezone, "Europe/London"); assert.equal(custom.revision, 2);
    opened.history.saveSettings("default", { ...migrated, weekly_hour: 9, timezone: "America/Bahia" }, migrated.revision);
    opened.close(); opened = new BotDatabase(filename);
    assert.equal(opened.history.getSettings("default").weekly_hour, 9);
    assert.equal(opened.history.getSettings("default").timezone, "America/Bahia");
  } finally { opened?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("default Monday recap is scheduled at 12:00 UTC with UTC week boundaries", () => {
  const opened = new BotDatabase(":memory:");
  try {
    const settings = opened.history.getSettings("guild");
    const period = weeklyPeriod(settings, Date.parse("2026-10-19T12:00:00.000Z"));
    assert.equal(period.scheduledAt, "2026-10-19T12:00:00.000Z");
    assert.equal(period.start, "2026-10-12T00:00:00.000Z");
    assert.equal(period.end, "2026-10-19T00:00:00.000Z");
  } finally { opened.close(); }
});
