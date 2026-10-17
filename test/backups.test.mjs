import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { backupDatabaseBeforeMigration } from "../dist/backups.js";
import { writeDeploymentHealth, clearDeploymentHealth } from "../dist/deploymentHealth.js";

test("database backups include committed WAL rows and preserve pre-migration contents", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "openfront-backup-"));
  const filename = path.join(directory, "bot.db"), source = new DatabaseSync(filename);
  t.after(() => { source.close(); rmSync(directory, { recursive: true, force: true }); });
  source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES ('linked')");
  assert.ok(existsSync(`${filename}-wal`));
  const backup = backupDatabaseBeforeMigration(filename);
  source.exec("ALTER TABLE users ADD COLUMN migrated TEXT; DELETE FROM users");
  const restored = new DatabaseSync(backup, { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT id FROM users").get().id, "linked");
    assert.equal(restored.prepare("PRAGMA table_info(users)").all().length, 1);
    assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { restored.close(); }
});

test("backup retention is per database and keeps unrelated files", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "openfront-retention-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "bot.db"), another = path.join(directory, "another.db");
  for (const name of [filename, another]) { const db = new DatabaseSync(name); db.exec("CREATE TABLE example (id INTEGER PRIMARY KEY)"); db.close(); }
  const otherBackup = backupDatabaseBeforeMigration(another, { retain: 2 });
  const backups = path.join(directory, "backups");
  writeFileSync(path.join(backups, "unrelated.db"), "do not remove");
  const snapshots = [];
  for (let i = 0; i < 4; i++) {
    const snapshot = backupDatabaseBeforeMigration(filename, { retain: 2 });
    snapshots.push(snapshot);
    // Make creation order observable even on filesystems with coarse timestamp precision.
    utimesSync(snapshot, new Date(`2020-01-0${i + 1}T00:00:00Z`), new Date(`2020-01-0${i + 1}T00:00:00Z`));
  }
  assert.deepEqual(snapshots.map(existsSync), [false, false, true, true]);
  assert.ok(existsSync(otherBackup));
  assert.equal(readdirSync(backups).length, 4);
  assert.equal(readFileSync(path.join(backups, "unrelated.db"), "utf8"), "do not remove");
});

test("new and in-memory databases are skipped and invalid backups stop migrations", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "openfront-bad-backup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(backupDatabaseBeforeMigration(":memory:"), null);
  assert.equal(backupDatabaseBeforeMigration(path.join(directory, "new.db")), null);
  assert.equal(existsSync(path.join(directory, "backups")), false);
  const filename = path.join(directory, "broken.db");
  writeFileSync(filename, "invalid sqlite database");
  assert.throws(() => backupDatabaseBeforeMigration(filename), /migration has been stopped/);
  assert.deepEqual(readdirSync(path.join(directory, "backups")), []);
  assert.equal(readFileSync(filename, "utf8"), "invalid sqlite database");
});

test("deployment readiness belongs to the currently logged-in process", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "openfront-health-"));
  const savedFile = process.env.BOT_HEALTH_FILE, savedCommit = process.env.BOT_DEPLOY_COMMIT;
  t.after(() => {
    if (savedFile === undefined) delete process.env.BOT_HEALTH_FILE; else process.env.BOT_HEALTH_FILE = savedFile;
    if (savedCommit === undefined) delete process.env.BOT_DEPLOY_COMMIT; else process.env.BOT_DEPLOY_COMMIT = savedCommit;
    rmSync(directory, { recursive: true, force: true });
  });
  process.env.BOT_HEALTH_FILE = path.join(directory, "ready.json");
  process.env.BOT_DEPLOY_COMMIT = "a".repeat(40);
  writeDeploymentHealth();
  const state = JSON.parse(readFileSync(process.env.BOT_HEALTH_FILE, "utf8"));
  assert.equal(state.commit, process.env.BOT_DEPLOY_COMMIT);
  assert.equal(state.pid, process.pid);
  writeFileSync(process.env.BOT_HEALTH_FILE, JSON.stringify({ ...state, pid: process.pid + 1 }));
  clearDeploymentHealth();
  assert.ok(existsSync(process.env.BOT_HEALTH_FILE));
  writeDeploymentHealth();
  clearDeploymentHealth();
  assert.equal(existsSync(process.env.BOT_HEALTH_FILE), false);
});
