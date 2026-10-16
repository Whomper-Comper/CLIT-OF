import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface DatabaseBackupOptions {
  directory?: string;
  retain?: number;
}

/** Take a consistent, verified SQLite snapshot before any schema changes. */
export function backupDatabaseBeforeMigration(filename: string, options: DatabaseBackupOptions = {}): string | null {
  if (filename === ":memory:" || filename === "" || !fs.existsSync(filename) || fs.statSync(filename).size === 0) return null;
  const retain = options.retain ?? 5;
  if (!Number.isSafeInteger(retain) || retain < 1 || retain > 100) throw new Error("Database backup retention must be from 1 to 100.");
  const databasePath = path.resolve(filename);
  const directory = path.resolve(options.directory ?? path.join(path.dirname(databasePath), "backups"));
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const prefix = `openfront-${createHash("sha256").update(databasePath).digest("hex").slice(0, 12)}-`;
  const name = `${prefix}${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.db`;
  const destination = path.join(directory, name);
  const temporary = `${destination}.partial`;
  try {
    const source = new DatabaseSync(databasePath, { readOnly: true });
    try {
      source.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
      // VACUUM INTO includes committed WAL contents, unlike copying the main database file.
      source.prepare("VACUUM INTO ?").run(temporary);
    } finally { source.close(); }
    fs.chmodSync(temporary, 0o600);
    const snapshot = new DatabaseSync(temporary, { readOnly: true });
    try {
      const results = snapshot.prepare("PRAGMA integrity_check").all();
      if (results.length !== 1 || results[0].integrity_check !== "ok") throw new Error("The database backup failed its integrity check.");
    } finally { snapshot.close(); }
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw new Error("Could not back up the database before migration. The migration has been stopped.", { cause: error });
  }
  // Rotate only snapshots for this database. Failed snapshots never replace good backups.
  const snapshots = fs.readdirSync(directory).filter(entry => entry.startsWith(prefix) && entry.endsWith(".db"))
    .map(entry => ({ filename: path.join(directory, entry), time: fs.statSync(path.join(directory, entry)).mtimeMs }))
    .sort((a, b) => b.time - a.time || b.filename.localeCompare(a.filename));
  const older = snapshots.filter(snapshot => snapshot.filename !== destination).slice(retain - 1);
  for (const snapshot of older) fs.unlinkSync(snapshot.filename);
  return destination;
}
