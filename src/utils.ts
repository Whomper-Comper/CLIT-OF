/**
 * Shared utility functions for the CLIT-OF bot.
 */

// Public IDs are short, URL-safe alphanumeric tokens (max 22 chars).
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{1,22}$/;

// Discord snowflakes are 17-20 digit numeric strings.
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

// Discord mention format: <@123456789012345678> or <@!123456789012345678>
const DISCORD_MENTION_RE = /^<@!?(\d{17,20})>$/;

/**
 * Extracts a numeric Discord ID from a raw snowflake or a mention string.
 * Returns null if the input is not a valid Discord user identifier.
 */
export function extractDiscordId(input: string): string | null {
  const trimmed = input.trim();
  if (DISCORD_SNOWFLAKE_RE.test(trimmed)) {
    return trimmed;
  }
  const match = DISCORD_MENTION_RE.exec(trimmed);
  if (match) {
    return match[1];
  }
  return null;
}

/**
 * Returns `true` when `input` is a valid Discord snowflake or Discord mention.
 */
export function isDiscordSnowflake(input: string): boolean {
  return extractDiscordId(input) !== null;
}

/**
 * Resolves an OpenFront player Public ID from either a raw ID,
 * a profile URL, or an OpenFront web link.
 *
 * Supported formats:
 * - `https://openfront.io/player/HabCsQYR`
 * - `https://openfront.io/player/HabCsQYR/`
 * - `http://openfront.io/player/HabCsQYR?tab=stats`
 * - `openfront.io/player/HabCsQYR`
 * - `<https://openfront.io/player/HabCsQYR>` (Discord embed suppression)
 * - `https://openfront.io/v/1.0.0/player/HabCsQYR`
 * - `https://openfront.io/w1/player/HabCsQYR`
 * - `https://openfront.io/#modal=profile&publicID=HabCsQYR`
 * - `https://openfront.io/?publicID=HabCsQYR`
 * - `https://ofstats.io/player/HabCsQYR`
 * - `HabCsQYR` (raw ID, returned as-is)
 */
export function resolveOpenFrontId(input: string): string {
  if (!input) return "";

  // 1. Strip surrounding Discord angle brackets (<url>), quotes, and extra whitespace
  let clean = input.trim().replace(/^<+|>+$/g, "").replace(/^["']|["']$/g, "").trim();

  // 2. Try parsing as a URL
  try {
    const urlStr = /^https?:\/\//i.test(clean) ? clean : `https://${clean}`;
    const url = new URL(urlStr);

    // Check query params: ?publicID=... or ?publicId=... or ?player=...
    const qId =
      url.searchParams.get("publicID") ||
      url.searchParams.get("publicId") ||
      url.searchParams.get("player") ||
      url.searchParams.get("id");
    if (qId && PUBLIC_ID_RE.test(qId.trim())) {
      return qId.trim();
    }

    // Check hash params: #modal=profile&publicID=... or #/player/...
    if (url.hash) {
      const hashStr = url.hash.replace(/^#\/?/, "");
      try {
        const hashParams = new URLSearchParams(hashStr);
        const hId = hashParams.get("publicID") || hashParams.get("publicId");
        if (hId && PUBLIC_ID_RE.test(hId.trim())) {
          return hId.trim();
        }
      } catch {
        // Not a URLSearchParams string
      }

      const hashPlayerMatch = /\/player\/([A-Za-z0-9_-]{1,22})(?:\/|[?#]|$)/i.exec(url.hash);
      if (hashPlayerMatch && PUBLIC_ID_RE.test(hashPlayerMatch[1])) {
        return hashPlayerMatch[1];
      }
    }

    // Check pathname: /player/:publicId (supports prefixes like /v/:commit/player/:id or /w1/player/:id)
    const pathMatch = /\/player\/([A-Za-z0-9_-]{1,22})(?:\/|[?#]|$)/i.exec(url.pathname);
    if (pathMatch && PUBLIC_ID_RE.test(decodeURIComponent(pathMatch[1]))) {
      return decodeURIComponent(pathMatch[1]);
    }
  } catch {
    // Not a valid URL — fall through to bare check
  }

  // 3. If input looks like a bare Public ID, return it
  if (PUBLIC_ID_RE.test(clean)) {
    return clean;
  }

  return clean;
}

/**
 * Normalises an SQLite date string (e.g. from datetime('now')) or ISO string
 * into a valid ISO-8601 UTC string with the 'Z' indicator.
 */
export function normaliseDateUTC(sqliteDatetime: string): string {
  if (!sqliteDatetime) return sqliteDatetime;
  const s = sqliteDatetime.trim();
  if (s.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(s)) return s;
  // SQLite's legacy datetime('now') produces "YYYY-MM-DD HH:MM:SS"; treat as UTC.
  return s.replace(" ", "T") + "Z";
}

/**
 * Converts a database date string or timestamp into Unix epoch seconds.
 * Returns null if parsing fails.
 */
export function toEpochSeconds(dateInput: string | null | undefined): number | null {
  if (!dateInput) return null;
  const utcString = normaliseDateUTC(dateInput);
  const time = new Date(utcString).getTime();
  if (Number.isFinite(time)) {
    return Math.floor(time / 1000);
  }
  return null;
}
