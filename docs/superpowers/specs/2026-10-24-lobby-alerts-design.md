# OpenFront lobby alerts

Date: 2026-10-24
Status: implemented and locally verified (540 tests passing); production feed access unverified because of a Cloudflare challenge

## Intent and requested behavior

Players opt into alerts for live OpenFront lobbies matching player count,
map, and/or game mode. Watch OpenFront itself, rather than Discord lobby
channels. Attempt a DM first. When Discord rejects the DM, mention the player
in a configured server channel and tell them to enable DMs from server members.
After each delivered alert, the player has three minutes to explicitly choose
to continue searching. Without a response, searching stops automatically.

The user selected DM delivery with server fallback. Defaults below are builder
proposals, rather than separately approved requirements.

## Approaches considered

- Server-channel alerts: simpler shared delivery but every match is public.
- DMs only: private delivery but blocked DMs silently lose useful alerts.
- DMs first with a server fallback: selected by the user; requires independent
  durable delivery state for each transport and an administrator-owned destination.

## Member commands and matching

Add a guild-only `/lobby` command with `watch`, `list`, `remove`, `resume`, `stop`, and
`configure` subcommands. Replies containing preferences and configuration
are private. Account linking is not required.

`watch` saves a named rule with optional map, mode, lobby category, minimum
current players, and maximum current players. Require at least one filter.
All specified filters within a rule must match; separate rules are alternatives.
Omitted filters mean any value. Validate numeric ranges and reject minimum
greater than maximum. Counts refer to currently connected players reported by
OpenFront, not bots, team size, or configured lobby capacity; command wording
must make that explicit. Use supported names from the compatible source's
catalog for map/mode/category choices or autocomplete. Normalize case and
whitespace, without fuzzy substring matching. Allow at most ten rules per member
per guild, bounded names, and a private paginated list with rule IDs for removal.

The private save response explains that blocked DMs cause a public fallback
mention. A configured fallback destination is required before accepting watches.
Removing a rule invalidates pending work whose remaining rules no longer match.
`watch` starts or restarts that member's search using their saved rules; `resume`
restarts saved rules without needing to recreate them; `stop` immediately stops
the search and invalidates pending notifications and continuation controls.
`list` displays the search state as well as the saved rules.

Only notify for currently joinable, not-full lobbies whose available metadata
proves every selected condition. Do not guess unknown map, mode, capacity, or
count fields. Queued lobbies without an active join/start window do not qualify.
Check newly added rules against the current fresh feed as well as later updates.

## Three-minute continuation window

Use a **Continue searching** button as the explicit response on both DM and
fallback alerts. Each alert states: "Want me to keep searching? Click Continue
searching within 3 minutes, otherwise I'll stop." Include a Discord deadline
timestamp so the remaining window is clear.

Keep one search session per guild/member, covering all their saved rules. Pause
matching for that session as soon as one matching lobby is selected, preventing
parallel alerts while delivery or the player's decision is pending. Start the
180-second response window at successful message creation, rather than queue
time or the rejected DM attempt. If a send is recovered after interruption, use
the original message's creation time; recovery must never extend the deadline.
If neither transport can deliver, stop the search and retain delivery diagnostics
without claiming that the player received an alert.
If delivery is cancelled because the lobby became obsolete before either
transport sent an alert, resume the still-enabled search automatically; there
is no player response deadline for an alert that was never delivered.

Only the intended player can click their alert's button, including on a public
fallback message. Bind controls to the saved notification, delivered message,
guild/member, and search generation. A valid click strictly before the deadline
atomically resumes searching and consumes the continuation token. At or after
the deadline, stop the search and reject the old control. Each subsequent alert
requires another response within its own three-minute window. The decision to
continue remains available even if the alerted lobby has already started.

Timeouts stop searching without deleting filters. Users restart with
`/lobby resume` or a new `watch`. Persist search state, generation, pending notification,
message binding, and deadline; enforce expiry after restart and before any new
matching/delivery work, independently of whether the old button could be edited.
Stale controls, repeated clicks, and old timeout callbacks cannot resume or stop
a replacement search. Disable consumed/expired buttons when feasible, but durable
state is authoritative. Member departure, explicit stop, and server disable
invalidate continuation controls. Re-enabling the server does not silently
restart stopped member searches.

## Server settings

`/lobby configure` requires the existing configuration access helper (Manage
Server or configured manager role), refreshed before persistence. Set an enabled
flag and one guild text-channel fallback destination; start disabled. Validate
View Channel, Send Messages, Embed Links, and Read Message History. Restrict
destination selection to ordinary guild text channels initially.

No fallback destination is inferred from the channel where a player subscribes.
Only mention the affected opted-in member, with explicit allowed user IDs and
no role/everyone parsing. If the fallback becomes unavailable, retain a bounded
diagnostic rather than redirecting alerts to another channel.

## Lobby feed and compatibility

The bot's current `api.ts` provides profiles/history, not a lobby list. The
adjacent game checkout exposes lobby snapshots and count deltas through worker
`/lobbies` WebSockets. Its `LobbySocket.ts` performs server discovery; its
`ZbinWire.ts` decoder explicitly documents a positional binary protocol tied to
the serving game build. Neither a JSON socket nor an undocumented legacy HTTP
endpoint may be assumed.

The implementation's first engineering step must verify the deployed feed and
discovery contract using official OpenFront sources and a read-only connection.
Prefer an available stable public JSON snapshot contract if one is verified.
Otherwise use a self-contained, revision-pinned lobby decoder and discovery
adapter based on the serving build. Document the upstream revision/license,
include known binary frame fixtures, and reject unsupported builds. The bot
must install and build independently of the neighboring game checkout. Do not
change the game repository, add an authenticated endpoint, or need a game login.
If a supported decoder cannot be obtained, report that concrete prerequisite;
do not present an unconnected or JSON-only stub as a working feature.

Maintain one shared source subscription per configured source, not per member
or guild. Merge count deltas only after a full snapshot; reconnect with bounded
backoff. Clear freshness on disconnect, decode failure, or deployment rollover.
Do not send from snapshots older than 30 seconds. Revalidate current lobby
presence, capacity, start deadline, and filter match immediately before delivery.
Stop and drain feed/delivery work before database close.

## Persistence and delivery

Add feature-owned SQLite tables through backed-up initialization for guild
settings, member rules, search sessions, and notifications. Preserve existing migration and
community lifecycle conventions. Keep source acquisition, matching, state, and
Discord transport separately testable.

Use one durable notification per `(guild, member, source, lobby ID)`, across all
matching rules and rule revisions. Reconnects, repeated frames, count crossings,
or restarts cannot schedule another notification for that key. Persist states
for pending DM, sending DM, DM sent, pending fallback, sending fallback, fallback
sent, cancelled, and needs review, with attempts/lease information. Do not mark a
failed send successful. Keep bounded work and fair guild/member scheduling.

DM content includes map, mode, current count/capacity where known, start time
where available, server context, and an official OpenFront join link. Do not
include identity tokens or other members' preferences.

Confirmed DM rejection (for example Discord code 50007) advances to fallback.
Transient failures retry with bounded backoff while the lobby remains valid.
An uncertain outcome after timeout/process interruption must be reconciled by
message nonce/marker or held for review; it must not produce an automatic public
fallback that may duplicate a successful DM. Apply equivalent ambiguity handling
to fallback sends. Existing community delivery code validates guild channels,
so do not pass DM channels through it without an explicit tested transport change.
Either add a narrow transport abstraction or use a feature-owned durable worker;
that internal choice is left to implementation planning.

Fallback text includes: `<@member>, a matching OpenFront lobby is available. I
couldn't DM you. Enable direct messages from server members in this server's
Privacy Settings to receive future lobby alerts privately.` Include the lobby
details/join link, with only that user's mention enabled.

Recheck current guild membership, enabled settings, destination revision, active
rules, and feed freshness after awaited lookups and before either transport.
Removing all watches or leaving the guild cancels pending personal notifications.
Guild removal purges feature data. OpenFront unlink does not clear preferences,
because the feature does not depend on linked identity. Retain notification
deduplication records for 30 days, then prune in bounded batches; never remove
records for lobby IDs still present in the feed. In-flight sends cannot be
recalled; already published messages have their own lifetime.

## Verification and documentation

Behavioral tests cover exact matching and combinations; invalid/missing fields;
full/queued/started/disappeared/stale lobbies; full/delta frames; reconnect and
unsupported protocol; rule limits and scoping; configuration authorization;
successful DM without fallback; confirmed rejection with a single fallback and
DM-enablement guidance; transient/ambiguous failures; restart deduplication;
continuation in DM and fallback; response before/exactly at/after the deadline;
timeout and resume with retained filters; owner/message/generation binding;
repeated clicks; no parallel alerts while awaiting a response; delayed delivery
and restart without deadline extension; old timeout versus new search races;
removal/disable/departure races; explicit mention permissions; bounded cleanup;
and shutdown. Fixtures use isolated SQLite and mocked Discord/feed boundaries.

Update README, command reference, administration, architecture, development,
and operations docs. Mention command registration as a later live operation.
Run `npm run build`, focused tests during development, `npm test`, and
`git diff --check`. Do not start/login/register/deploy the bot as a local check.
Preserve the existing README modification and untracked local agent guide.

## Non-goals

Creating or hosting games, monitoring Discord category contents, changing the
game/control panel, tracking private unlisted lobbies, role-wide pings, and
guaranteeing receipt of a DM or mobile notification are outside this feature.
