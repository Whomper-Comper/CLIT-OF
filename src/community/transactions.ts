import type { DatabaseSync } from "node:sqlite";
let sequence = 0;

/** SAVEPOINTs also work inside the caller's existing migration/identity transaction. */
export function withCommunityTransaction<T>(sql: DatabaseSync, action: () => T): T {
  const name = `community_${++sequence}`;
  sql.exec(`SAVEPOINT ${name}`);
  try {
    const result = action();
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Community transactions must be synchronous.");
    sql.exec(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    sql.exec(`ROLLBACK TO SAVEPOINT ${name}`);
    sql.exec(`RELEASE SAVEPOINT ${name}`);
    throw error;
  }
}
