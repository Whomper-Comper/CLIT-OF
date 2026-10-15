import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

export const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN || "",
  CLIENT_ID: process.env.CLIENT_ID || "",
  OPENFRONT_API_BASE: (process.env.OPENFRONT_API_BASE || "https://api.openfront.io").replace(/\/+$/, ""),
  DB_PATH: process.env.DB_PATH || path.resolve(process.cwd(), "data", "openfront_bot.db"),
  DEFAULT_SYNC_INTERVAL_MINS: Number(process.env.DEFAULT_SYNC_INTERVAL_MINS || "10"),
};

export function validateConfig() {
  const missing: string[] = [];
  if (!CONFIG.DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  if (!CONFIG.CLIENT_ID) missing.push("CLIENT_ID");

  if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}. Set them in .env.`);
  }

  const interval = CONFIG.DEFAULT_SYNC_INTERVAL_MINS;
  if (!Number.isInteger(interval) || interval < 2 || interval > 1440) {
    throw new Error("DEFAULT_SYNC_INTERVAL_MINS must be an integer between 2 and 1440.");
  }
}
