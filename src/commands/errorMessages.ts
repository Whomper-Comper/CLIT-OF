import { OpenFrontApiError } from "../api.js";
import { db } from "../db.js";
import { CommandError, shortText } from "./support.js";

/** Explain known failure classes without exposing HTTP bodies, tokens, SQL, or stack traces. */
export function commandErrorMessage(error: unknown, guildId: string | null): string {
  const knownSettingConflict = error instanceof Error && /^(The (access role|debug role)|Debug settings) changed in another session\./.test(error.message);
  const expected = error instanceof CommandError || error instanceof OpenFrontApiError || knownSettingConflict;
  const message = expected && error instanceof Error ? error.message : "An unexpected error occurred. Please try again later.";
  if (!guildId || !db.getDebugSettings(guildId)?.verbose_errors) return shortText(message, 1900);
  let detail: string;
  if (error instanceof OpenFrontApiError) {
    detail = error.reason === "timeout" ? "The OpenFront request exceeded its time limit. The service may be overloaded or the connection may be slow. Wait a minute and retry."
      : error.reason === "network" ? "The bot could not reach OpenFront. A network, DNS, or OpenFront outage may be responsible. Retry later; a manager can check clan API connectivity with the doctor action."
      : error.status === 429 ? "OpenFront is rate limiting requests (HTTP 429). Wait before retrying; repeated commands can extend the problem."
      : error.reason === "http" ? `OpenFront rejected the request (HTTP ${error.status ?? "error"}). Its service may be unavailable or access requirements may have changed. Retry later; persistent failures need a bot maintainer.`
      : "OpenFront returned data the bot could not read safely. Some fields may be missing or the API format may have changed. Retry; if it persists, ask a maintainer to check the API response format.";
  } else if (error instanceof CommandError || knownSettingConflict) {
    detail = /role|permission|access/i.test(message) ? "Your assigned roles or the server's selected access role may have changed. Ask a server manager to check /config and your current roles. Clan and debug actions require their respective selected roles, even for administrators."
      : /another session|changed while|changed in|expired|menu/i.test(message) ? "The saved settings or menu session are no longer current. Open a fresh /config menu and repeat the change; expired or conflicting edits are blocked."
      : /member|server members|partial export/i.test(message) ? "Discord membership could not be confirmed. The user may have left, the Members intent may be unavailable, or Discord may be having connection problems. Retry and check the bot's Members intent."
      : /exactly one|required|input|page|choose a valid/i.test(message) ? "The selected action needs different inputs. Check its required options; use either a Discord user or an OpenFront ID for /whois or /stats, and exactly one ID or token for /link."
      : /wait|trying/i.test(message) ? "This command has a cooldown to protect Discord and OpenFront from repeated requests. Wait before running it again."
      : "The bot stopped this action because a required condition was not met. Follow the message above; if it keeps happening, ask a manager to check configuration and use /debug status to inspect queued work.";
  } else {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    detail = code === 50013 ? "Discord denied the operation (Missing Permissions). Check the bot's server/channel permissions and place its role above every role it manages."
      : code === 50001 ? "Discord denied access to a server, channel, or member. Check that the bot is installed and can view the relevant channel."
      : code === 10007 ? "Discord could not find that member. They may have left the server; refresh membership before retrying."
      : code === 50035 ? "Discord rejected the response format. A field or attachment may exceed a Discord limit; ask a maintainer to review the command output."
      : code === "SQLITE_BUSY" || code === "ERR_SQLITE_BUSY" ? "The database is busy. Another operation may be writing to it. Wait briefly and retry; persistent failures need a maintainer to check storage."
      : "The bot could not finish the operation. Discord, local storage, or an unexpected bot error may be responsible. Retry once, then report the command and time to a maintainer so they can check the logs.";
  }
  return shortText(`${message}\n\nWhat may be happening: ${detail}`, 1900);
}
