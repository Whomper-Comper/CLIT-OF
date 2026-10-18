# Clan scheduling, challenges, onboarding, and dice duels

Date: 2026-10-18

Status: Written design for user review; implementation has not started.

## Intent and approved scope

The user wants all of the following implemented in the existing OpenFront Discord bot: team game scheduling; a challenge wheel with curated map/settings combinations; statistic milestone cards; a server-wide bingo board; recurring member availability with overlap suggestions; a newcomer checklist with officer visibility; event/squad signups with limits, reserves, and optional reminders; and two-player dice duels.

The user approved the conversational design on 2026-10-18. Team scheduling and event/squad signups are one feature. The seven resulting feature areas below form one release with separately testable modules. The detailed defaults in this written document remain subject to review.

Success means members can use all seven features through Discord, officers can manage them without editing files, and saved schedules, signups, awards, boards, and challenges survive a bot restart. Existing identity, statistics, role synchronization, and configuration behavior must continue to work.

## Approach and project boundaries

Use focused modules in the existing TypeScript/discord.js process, backed by the existing SQLite database. Reuse effective account links, configured clan mappings, statistics parsing, timezone utilities where suitable, and the shared interaction error boundary. Keep the existing `/dice` interface unchanged and add `/duel` separately.

This approach provides persistent buttons and shared identity without another deployment. Command-only features with in-memory state would be smaller but would lose event and duel state on restart. A companion service would add deployment and identity integration work without helping these Discord flows.

The bot schedules sessions and presents settings for a human to host in OpenFront. Creating game lobbies through an authenticated game-server API is outside this release. Cards and boards are polished Discord embeds with buttons; no image-generation service or new rendering dependency is required. The separate desktop control panel is outside this change.

## Shared permissions and interaction behavior

- All new commands are server-only. Members may manage their own availability, signups, notification choice, bingo claims, and duel invitations.
- For these new features, community officers are holders of the configured manager role or an officer/leader role mapped to a configured clan. This extends access only for the new community features; existing `/clan`, `/config`, and `/debug` checks keep their current rules.
- Community officers manage events, wheel presets, bingo boards and claims, and the newcomer queue. Changing announcement destinations or milestone settings uses existing configuration access: Manage Server or the configured manager role.
- Refresh guild membership and reread applicable roles before every privileged action, including buttons. Match all persistent component identifiers to their saved guild, channel, and message. Never trust permissions or ownership encoded in a component ID.
- Availability editing, onboarding details, claims/review, configuration, and access errors are private. Published events, wheel spins, milestone announcements, bingo boards, and accepted duel results are public. A member's raw recurring availability is visible only to that member and officers; public suggestions show counts rather than a list of private schedules.
- Validate text lengths and dates; escape user-provided labels; suppress unintended mentions. Explicit event reminders may mention only opted-in, currently confirmed participants.
- Persistent buttons reread database state on every click. Expired private menus ask the member to reopen the command. Stale event and board messages offer an actionable refresh path.

## 1. Team events and squad signups

Commands: `/event create`, `/event list`, `/event view`, `/event edit`, and `/event cancel`. Published event messages provide Join, Withdraw, Choose squad, and Reminder buttons. A private management flow handles creation/edit fields that do not fit conveniently in slash options.

An event contains its server, title, description, start instant, duration, creator, destination channel/message, total capacity, optional named squads with capacities, reminder lead time, status, and revision. Start time is entered as `YYYY-MM-DD HH:mm` plus an IANA timezone; display the interpreted date and local Discord timestamp for confirmation before publishing. Reject nonexistent DST wall times and require an explicit offset for ambiguous ones. The stored instant is UTC. Events last 15-720 minutes, start within the next 365 days, and accept 1-100 confirmed members. Default duration is 120 minutes and default capacity is 20.

Officers may define up to 20 named squads; their capacities must sum to the event capacity. Without squads, members join the event directly. With squads, a member selects a squad before joining. Each member has at most one signup per event. Full events/squads put the member on a clearly labeled reserve list, with a stable database sequence determining order. Repeated Join or Withdraw clicks are idempotent.

Join, withdrawal, capacity edits, and reserve promotion execute atomically. When a seat opens, promote the earliest eligible reserve for that squad (or the event if unsquadded). Validate current guild membership before promotion; remove departed members and continue. Never exceed a capacity when simultaneous interactions arrive. Reject reducing capacity below confirmed occupancy or removing an occupied squad; officers can first move members through the management flow. Members can change squad atomically, with the destination's capacity determining confirmed/reserve status.

Signups close at the start instant. Past events remain viewable for 90 days, with controls disabled. Cancellation closes signups, invalidates pending reminders, and updates the published card. A cancelled event does not satisfy the onboarding signup step. Event edits increment a revision, update the card, and invalidate obsolete reminder jobs.

Reminders are optional and off by default. Officers can choose 15, 30, or 60 minutes before start; members explicitly opt in per event using the Reminder button. Send one event-channel reminder listing only opted-in confirmed members, splitting messages if required by Discord limits. Withdrawal, reserve status, cancellation, changed event time, or departure prevents an obsolete reminder. No direct messages are needed.

Publish views paginate member lists rather than exceeding embed limits. Persist the canonical event before posting; a failed Discord post leaves a recoverable draft. If the post succeeds but saving its message ID fails, surface the failure for officer reconciliation instead of silently creating another published event.

## 2. Availability and overlap suggestions

Commands: `/availability set`, `/availability view`, `/availability clear`, and `/availability suggest`. Editing uses day choices, local `HH:mm` start/end, and an IANA timezone. A member can save up to 14 weekly windows, each between 30 minutes and 12 hours. Support windows crossing midnight and reject a zero-length window. Merge overlapping windows for counting; never count one member twice in a slot.

Store recurring local weekdays/times and timezone, not a fixed UTC offset. Suggestions project those windows onto actual dates in the next 14 days, so DST changes are respected. Evaluate candidate starts every 30 minutes and count members available for the entire requested duration. Default duration is two hours, configurable to 30-240 minutes. Return the best three distinct sessions ordered by member count, then earlier start; suppress overlapping suggestions with the same attendee set. Exclude past starts and members who left the guild. Explain when no common time exists and show the best partial overlap without claiming everyone can attend.

Discord timestamps provide each viewer's local date/time. Officers can turn a suggestion into a prefilled event draft. A suggestion itself does not publish an event or sign anyone up.

## 3. Newcomer checklist and officer queue

Commands: `/onboarding status` for the caller and `/onboarding queue` for officers. An officer may inspect a selected member privately. If there is more than one configured clan, choose the target clan explicitly; otherwise use the sole configured clan.

Show four ordered steps with actionable instructions/buttons:

1. Link an OpenFront account using the existing `/link` flow. Display server-approved links accurately rather than presenting them as bot-wide ownership verification.
2. Join the selected configured clan. Resolve the current account's clan membership from a fresh profile. An approval/join role indicates waiting for an invitation, not completed clan membership. Missing API data shows Unknown with retry guidance.
3. Save at least one valid availability window.
4. Hold a confirmed signup to an upcoming non-cancelled event, or have a retained confirmed signup to a past non-cancelled event. This records joining an event, not proof of attendance.

Checklist progress is derived from current identity, membership, availability, and retained signups, avoiding a second contradictory copy of those facts. A short onboarding enrollment record saves the selected clan and enrollment date, and a completion marker supports bingo evidence. Unlinking/relinking or removing required data reevaluates the corresponding steps. The officer queue shows enrolled current members, next incomplete step, and waiting/unknown status with pagination. It does not automatically fetch every unlinked member's profile or publish personal details.

## 4. Curated challenge wheel

Commands: `/wheel spin`, `/wheel presets`, `/wheel add`, `/wheel edit`, and `/wheel remove`. Members may spin; officers manage presets. A spin chooses one enabled, complete preset with cryptographic randomness. A preset bundles an allowed map selection and settings; never generate each setting independently. When a preset contains multiple compatible maps, choose one map from its explicit list after choosing the preset. Show the exact map, mode, teams, difficulty, bots/nations, disabled units, donations, and hosting instructions.

Ship these six editable starter presets, using names and setting types checked against the local OpenFront source:

| Preset | Allowed maps | Rules |
| --- | --- | --- |
| Classic clan teams | World, Europe | Team, two teams, Medium, 100 bots, default nations |
| Squad skirmish | Europe, Black Sea | Team, Quads, Medium, 50 bots, nations disabled |
| Naval night | Black Sea, Caribbean | Team, two teams, Medium, 100 bots, default nations |
| Conventional warfare | World, Europe | Team, two teams, Medium, 100 bots, default nations; nuclear units disabled |
| Friendly free-for-all | Europe, World | Free For All, Medium, 100 bots, default nations |
| Humans versus nations | World, Europe | Team, Humans Vs Nations, Hard, zero bots, default nations |

All starters use normal map size, normal resources/build times, manual spawn, and enabled gold/troop donations; FFA leaves team count unset. Conventional warfare disables Atom Bomb, Hydrogen Bomb, MIRV, and MIRV Warhead. Naval night emphasizes naval play in its instructions and leaves ports/warships enabled. Other disabled-unit lists are empty.

Validate preset fields against the bot's explicit supported map/settings catalog, allow at most 50 presets per guild and ten maps per preset, and show validation errors before saving. Updating the catalog is an ordinary source change, not an unbounded import of upstream code. Display that these are suggested hosting settings; curated means compatible, not a claim of competitive balance. A five-second per-user cooldown bounds repeated spins. Spins can prefill an event draft without publishing it.

## 5. Statistic milestone cards

Commands: `/milestones view` and `/milestones configure`. A private configuration flow selects a public announcement channel and optional thresholds. Default milestones use public Team lifetime counters: games played at 10, 50, 100, 250, and 500; wins at 1, 10, 25, 50, and 100. Accept up to ten ascending, unique, positive integer thresholds per metric. Use the existing BigInt statistics parser without converting counters through floating-point numbers.

`view` checks the caller's effective linked account and displays earned and upcoming milestones. Background checks run only after a server enables milestone announcements and selects a valid channel. Poll eligible current linked clan members at most once per 15 minutes, sharing a bounded fair API budget with other new community work. Missing or partial statistics do not become zero or earn an award based on an incomplete metric. Recheck identity and membership after a fetch before storing results or sending. An observation for which wins, losses, and total are inconsistent is unavailable rather than an award source. Disabling announcements stops background polling and cancels pending announcement jobs; existing earned cards remain privately viewable until personal-data cleanup.

On the first valid observation of an account or newly added threshold, save already reached thresholds as earned, visible in `view`, without posting old achievements. Later upward crossings enqueue an announcement once per guild/account/metric/threshold. If several thresholds are crossed between observations, save each award and combine them in one card per member per check. A card shows member, public profile, metric, achieved threshold(s), observed total, and observation time. It does not invent the historical moment the milestone was reached.

Once an award is earned, a lower subsequent counter does not create a second award. Re-verifying the same account preserves award deduplication; changing accounts starts a new baseline. Removing an account's personal records through unlink/deletion also removes its baseline and awards; a later link initializes silently again. Notification delivery uses persisted jobs and exposes failures to officers rather than losing earned cards.

## 6. Shared server bingo

Commands: `/bingo view`, `/bingo create`, `/bingo claim`, `/bingo review`, and `/bingo reset`. Only officers create/reset a board or approve/reject claims. One active 5x5 board exists per server, with a free center, 24 immutable challenge definitions, creation time, optional closing date, and revision. Closing date is optional; boards do not reset on an automatic schedule. An officer reset explicitly confirms replacement and archives the prior board.

The public board presents five rows of numbered cells with clear completion marks, plus completed lines and progress. Claims select a cell and provide a short explanation and optional HTTPS evidence URL. Manual cells show Pending until approved; repeat claims by the same member/cell remain one pending claim. Automatic cells show observed progress and cannot be completed by an unchecked member claim. Officers can correct a mistaken manual approval with an audited reason.

The default 24 challenges are:

| Automatic objectives | Manual objectives requiring officer approval |
| --- | --- |
| Record 5, 15, and 30 public Team appearances (three cells) | Win on Europe; win on World; win on Black Sea |
| Record 1, 5, and 10 public Team wins (three cells) | Win without nukes; win a naval-focused match; make a comeback win |
| Have 2, 5, and 8 different linked members finish public Team games (three cells) | Teach a newcomer; hold a training session; finish a full-squad session |
| Have 2 and 3 linked clan members finish the same Team game (two cells) | Share a clan group screenshot; play three different maps; finish a clan night |
| Have 3 different members save availability after board creation (one cell) | |

Automatic game evidence comes from the existing retained player sessions only when player history and collection are enabled and healthy. Count games starting on/after board creation and before closure, with a non-null end, Public/Team mode, a configured clan tag, and a currently eligible identity/member. A team appearance is one account/game pair; a win is a winning appearance. Shared-game objectives group distinct accounts by game ID. Late collection is acceptable; already stored pre-board matches never count. Surface collection-disabled, incomplete-coverage, or unavailable state rather than implying exhaustive verification. Manual objectives stay usable with collection off.

Freeze challenge targets when the board is created. Officers may customize the 24 definitions in a private draft before publication, using the supported automatic objective types or manual descriptions. Once published, changes require a new board. Unique evidence keys prevent polling from counting the same game or availability submission again. Game evidence follows the server's player-history retention window; a long-running board labels that limit rather than claiming to count expired history. Recompute current automatic cells and lines when evidence is removed through retention, unlink, departure, or privacy settings. Manual corrections likewise recompute current lines. Record notification keys separately so losing and regaining a line never produces duplicate completion announcements. A board reset creates a new notification namespace.

## 7. Two-player dice duel

Command: `/duel opponent:@member`. The challenger and opponent must be different current non-bot members of the same guild. Publish a challenge with Accept, Decline, and Cancel buttons. Only the opponent may accept/decline; only the challenger may cancel a pending challenge. Invitations expire after two minutes. Limit each member to one pending duel per server and apply a 30-second invitation cooldown per challenger.

On acceptance, verify both memberships, then atomically transition the saved invitation from Pending to Resolved and store two independent cryptographically random D6 rolls. Only the interaction that wins the state transition may draw or resolve the duel; duplicate clicks return the saved outcome. The higher roll wins. Equal rolls produce a tie with a Rematch button that creates a fresh invitation from the clicking participant to the other participant; fresh acceptance is required. There are no bets, currency, or ranked standings.

Store resolved rolls before showing an animation/result so a restart or failed Discord edit cannot reroll the outcome. Declined, cancelled, expired, and resolved invitations disable original controls. A View/Refresh result path recovers an edit failure. Retain duel records for 30 days.

## Persistence and module boundaries

Add a `CommunityStore` initialized inside the existing backed-up schema transaction and exposed through `BotDatabase`, following the separation used by `HistoryStore`. Its public operations enforce guild scoping, revisions, uniqueness, and atomic state transitions rather than allowing command handlers to assemble writes.

Logical records are:

- Community settings: destinations, milestone enablement/thresholds, revision.
- Availability: guild/member timezone and recurring windows, update timestamp.
- Events, squads, and signups: immutable IDs, revisions, status, message binding, ordered reserve sequence, reminder preference.
- Onboarding enrollments/completion evidence: selected clan, enrollment and completion timestamps.
- Wheel presets: guild, name, validated map/settings payload, enabled status, revision.
- Milestone observations and awards: account and identity binding, exact counters, threshold, baseline/award times.
- Bingo boards, cells, evidence, and claims: board identity, fixed objectives, progress, review audit, completion status.
- Duel invitations/results: participant IDs, message binding, expiry, state and stored rolls.
- Delivery jobs: kind, deduplication key, payload/reference, due time, attempt/backoff state, destination/message ID, terminal result.

Keep scheduling, preset selection, milestone evaluation, bingo rules, and duel transitions in focused domain modules with injectable clocks/randomness. Put Discord rendering/commands in corresponding `src/commands/` modules. Central routing in `src/index.ts` delegates components before slash execution, preserving the common error boundary. Shared persistent data does not require one oversized command or service file.

## Background work and delivery failures

One `CommunityService` starts at ClientReady and stops/drains during normal shutdown and login-failure cleanup. A non-overlapping tick runs every minute. It expires invitations/events, processes due reminders and announcements, refreshes opted-in milestone profiles, and updates bingo progress. Work rotates fairly across guilds, with at most eight upstream requests and four outbound sends per tick. Existing history/role budgets remain independent and unchanged. On-demand lookups use the current command throttles and API cache.

Persist due work before attempting delivery. Use atomic claiming with a five-minute lease, stable delivery keys, and Discord nonces/enforced nonce deduplication where supported. Recover known messages by editing rather than reposting. A network timeout after a potentially successful send, or a lease left in Sending by a stopped process, is ambiguous: reconcile recent bot messages using a stable job marker before retrying; if the outcome cannot be established, mark Needs review rather than repeatedly posting. Expose paused/failed jobs and a deliberate retry/reconcile action through the officer event management and milestone configuration flows. Do not promise exactly-once behavior across Discord and SQLite.

Use bounded exponential retries for definite transient failures. Configuration/permission failures pause delivery with an actionable officer-visible status; cancelled or obsolete jobs terminate. Reminders discovered after event start are skipped rather than sent late. Other reminders may send while their event is still upcoming. The bot never holds a database transaction across an awaited Discord/API request.

## Cleanup and existing privacy integration

Guild departure removes that member's availability, enrollment, active event signups, pending duels/claims, personal milestone data, and member-linked bingo evidence. Promote reserves as needed; invalidate pending notifications. Unlink and effective-account replacement remove or reset account-derived observations, awards, and bingo evidence without removing unrelated recurring availability or event signups. Every asynchronous response is checked against the current effective identity before it can recreate removed data.

Deletion-feed processing must clear community data for the deleted public account as well as existing history data. The existing deletion-sync health gate also applies to automatic player-derived community work. Disabling player history stops/clears automatic bingo game evidence; public profile milestones remain separately controlled by milestone enablement and respect account-deletion suppression. Already published messages have the same separate lifetime boundary as existing statistics/recap messages.

Keep completed/cancelled events and signups for 90 days, resolved/expired duels for 30 days, archived bingo boards/claims for 90 days, and completed delivery diagnostics for 30 days. Active records and earned milestones remain until the corresponding lifecycle cleanup. Server removal clears that server's community records. Prune during bounded background ticks with indexes for due work and guild/member/account lookups.

## Validation and acceptance

Use the repository's Node test runner and meaningful injected-clock/API/Discord fixtures. Verify:

- Existing command definitions and `/dice` behavior remain compatible; all new command definitions serialize and route correctly.
- Recurring availability handles midnight, real DST transitions, duplicate windows, full-duration overlap, private visibility, and distinct-member counts.
- Event joins at the last seat, duplicate clicks, squad moves, reserve ordering/promotion, departure, cancellation, revision changes, and restart recovery preserve capacity and reminder correctness.
- Onboarding distinguishes approved-to-join from actual clan membership, unknown upstream state from incomplete steps, and signup from attendance.
- Wheel outputs always belong to a complete supported preset; edited invalid combinations do not persist.
- Milestones handle exact large integers, initial baselines, skipped thresholds, partial/missing stats, identity changes, stale requests, and notification deduplication.
- Bingo enforces board scope, post-creation evidence, unique contributors, completed games, officer review, line counting, collection health, and reset isolation.
- Duel tests cover consent, unauthorized users, both winner orderings, ties/rematches, expiry, repeated acceptance, membership changes, and persisted results after edit failure/restart.
- Database migrations preserve existing data; new personal data is removed through unlink, departure, deletion-feed, and setting-disable paths as specified.
- Worker tests exercise fair budgets, stop/drain, retries, ambiguous sends, obsolete jobs, and missed reminder deadlines.

Run the TypeScript build, relevant targeted suites, and the full test suite before reporting implementation complete. Inspect representative serialized embeds/components for Discord size limits and exposed controls. Real Discord rendering and live API delivery require a running bot and are reported separately from local verification.

Update README and the command, administration, architecture, statistics/history, development, and operations references with the resulting commands, permissions, setup, collection dependencies, cleanup, and recovery behavior. Registering commands, starting a live bot, deployment, and pushing changes are separate operational actions and are not performed solely to review this spec.
