import fs from "node:fs";
import path from "node:path";

/** Publish only after Discord has delivered ClientReady and background work has started. */
export function writeDeploymentHealth() {
  const filename = process.env.BOT_HEALTH_FILE;
  if (!filename) return;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.partial`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ commit: process.env.BOT_DEPLOY_COMMIT ?? null,
      pid: process.pid, readyAt: new Date().toISOString() }), { mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function clearDeploymentHealth() {
  const filename = process.env.BOT_HEALTH_FILE;
  if (!filename) return;
  try {
    // A terminating old process must not remove the new process's readiness marker.
    if (JSON.parse(fs.readFileSync(filename, "utf8")).pid === process.pid) fs.unlinkSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("[Bot] Could not clear the deployment readiness marker.");
  }
}
