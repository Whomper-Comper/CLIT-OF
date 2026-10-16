import fs from "node:fs";

const [filename, commit, pid, earliestReady] = process.argv.slice(2);
try {
  const health = JSON.parse(fs.readFileSync(filename, "utf8"));
  const readyAt = Date.parse(health.readyAt);
  if (health.commit !== commit || health.pid !== Number(pid) || !Number.isSafeInteger(health.pid) || health.pid < 1 ||
    !Number.isFinite(readyAt) || readyAt < Number(earliestReady) || readyAt > Date.now() + 5000) process.exitCode = 1;
} catch { process.exitCode = 1; }
