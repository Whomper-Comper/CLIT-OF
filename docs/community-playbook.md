# Community playbook

Use this guide to get a server from initial configuration to its first clan night. The [command reference](commands.md) lists every option and limit; the [administration guide](server-administration.md#community-release-setup) covers permissions and recovery in detail.

## Set up the server

1. Install and start the bot using the [operations guide](operations.md). After updating an existing installation, register the updated commands in the intended server or global scope. Registration and starting the bot are separate operations.
2. A member with **Manage Server** opens `/config`, selects the manager/config role, and assigns it to the people who will manage the clan.
3. Configure the clan mappings and member/officer/leader roles. For the new community features, officers are members with the configured manager role or a mapped clan officer/leader role. Manage Server alone grants configuration access; it does not replace those community officer roles.
4. Give the bot **View Channel**, **Send Messages**, **Embed Links** and **Read Message History** in destinations used for public cards. Keep Server Members Intent enabled. Role synchronization also needs Manage Roles and the correct role hierarchy.
5. Decide whether to enable the two optional automatic features below. Scheduling, availability, the wheel, manual bingo and dice duels can be used without game collection.

| Feature | Enablement |
| --- | --- |
| Milestone announcements | Open `/milestones configure`, select a destination, choose thresholds, enable announcements and explicitly **Save**. Announcements start disabled. Initial observations baseline existing achievements silently. |
| Automatic bingo game cells | Enable player history and collection in `/config`, configure clan tags, and check deletion synchronization health. Only retained eligible observations count. Manual cells and availability contributions remain usable with collection off. |

Changing milestone destinations or settings requires **Manage Server** or the configured manager role. Existing `/clan` and `/debug` permissions retain their separate rules.

## Run a first clan night

1. Ask members to use `/availability set` to save their usual weekday, local start/end time and IANA timezone, such as `America/Bahia` or `Europe/London`. Raw schedules stay private to the member and authorized officers.
2. Run `/availability suggest`. Suggestions cover the next 14 days and show overlap counts and Discord timestamps in each reader's local time. The default session is 120 minutes; choose 30–240 minutes when needed.
3. An officer can use the private draft button on a suggestion. Alternatively, run `/event create` with a title, local start (`YYYY-MM-DD HH:mm`) and IANA timezone. Choose a date within the next 365 days. For a repeated daylight-saving time, provide the requested explicit UTC offset; nonexistent local times are rejected.
4. Review the interpreted time and event details. The defaults are 20 places and 120 minutes. Officers may edit the total capacity and named squads before publication; squad capacities must add up to the total.
5. Choose a reminder lead of 15, 30 or 60 minutes if wanted, then explicitly publish the event. Members join from the canonical public card and choose a squad when required. Full squads/events use ordered reserve lists; eligible reserves are promoted when a place opens.
6. Ask confirmed members who want a reminder to opt in using the card's **Reminder** control. Reminders default off and mention only currently eligible, confirmed, opted-in participants. Signups close at the event start.

Use `/event list` to discover published events, `/event view id:…` to find the canonical card, and `/event edit id:…` for officer management. A signup is a commitment to attend, not proof of attendance.

## Help newcomers get started

Ask a newcomer to open `/onboarding status`; if several clans are configured, select the intended clan. The private checklist guides them through linking, actual clan membership, availability and their first confirmed event signup.

The **approval role** means someone is waiting for an in-game invitation. It does not prove that they have joined the OpenFront clan. Unavailable upstream membership is shown as unknown rather than treated as a completed or failed step.

Officers use `/onboarding queue` to review enrolled members who need help. Members enroll by opening their checklist; the queue is private and shows ten members per page.

## Add challenges and shared goals

| Activity | Member workflow | Officer workflow |
| --- | --- | --- |
| Challenge wheel | `/wheel spin` selects a complete curated package and one of its allowed maps. | Use `/wheel presets`, `/wheel add`, `/wheel edit` or `/wheel remove`. Review and explicitly save changes. An officer's private draft button copies a spin into an unpublished event. |
| Milestones | `/milestones view` privately shows earned and upcoming public Team milestones for the current linked account. | Configure opt-in announcements and inspect delivery diagnostics in `/milestones configure`. Newly added thresholds also baseline silently. |
| Shared bingo | `/bingo view` shows the shared board; use `cell` to read a full challenge. Submit manual claims with `/bingo claim` or the public claim button. | `/bingo create` opens a private 24-challenge draft. Review and publish explicitly. Use `/bingo review` to approve/reject claims with a reason; `/bingo reset` requires confirmation and replaces the board. |
| Dice duel | `/duel opponent:@member` invites another current human member. Only the opponent accepts/declines; only the challenger cancels. | No officer setup or OpenFront account link is required. |

Wheel settings are suggestions for a human OpenFront host; the bot does not create a game lobby. The supported catalog is deliberate, and the presets do not promise competitive balance.

Bingo is a shared 5×5 board with a free center at cell 13. Published definitions are immutable. Automatic cells cannot be completed through unchecked manual claims. Claim explanations, optional HTTPS evidence and officer decisions stay private; evidence URLs are stored without being fetched.

Automatic bingo progress describes retained observations, not exhaustive clan activity. Partial scans and unavailable membership/collection hide automatic progress until a fresh scan completes. Corrections, retention, unlink and departure can reduce progress. Losing and regaining a line does not announce it again; an explicit reset creates a new notification namespace.

Duels save two independent D6 rolls before displaying the result. Repeated acceptance or a failed message edit cannot reroll them. Ties offer a fresh invitation requiring consent again. A member has one pending duel per server, with a 30-second challenger cooldown. The two-minute acceptance window starts at canonical control activation; publication waiting is separately bounded at two minutes. Queue time plus acceptance can approach four minutes, and the enabling request's duration reduces the visible window. Retries never extend it. Existing `/dice` remains a separate command.

## Recover a failed update

| Symptom | Action |
| --- | --- |
| An expired private menu or changed revision | Reopen the command and work from the current saved state. Private community menus expire after ten minutes. |
| Missing channel permissions | Correct the bot's destination permissions before retrying. |
| Event delivery failure | Reopen `/event edit id:…` and inspect the management diagnostics. |
| Milestone delivery failure | Open `/milestones configure`, select the delivery and use **Retry / reconcile**. |
| Bingo publication/update failure | Use `/bingo create` for an unpublished draft or `/bingo review` for an active board, then inspect delivery diagnostics. |
| A saved duel result failed to display | Use **Refresh** on the existing card. The saved rolls and activation deadline are reused. |
| Automatic bingo cells show refreshing/unavailable | Check history settings, collection/deletion health and current membership; allow the bounded scan to complete. Manual work remains available. |

**Needs review** means a send may already have succeeded. Preserve the existing bot recovery marker and use the deliberate retry/reconcile control. An unproven outcome stays reviewable rather than causing an automatic duplicate post. Do not delete an uncertain card merely to force another publication.

The community worker runs once per minute with shared limits of eight external validation/profile requests and four outbound operations. A publication and a later edit each consume a slot. A backlog can delay updates or expire an invitation before activation. Event reminders discovered after the event starts are skipped.

## Privacy and retention

- Unlink/account replacement clears account-derived milestone and bingo state and resets account-dependent onboarding completion. Independent recurring availability, event signups and duels survive ordinary unlink.
- Server departure removes that member's availability, enrollment, active signups, pending claims and pending duel consent. Reserve promotion and public-card closure are queued as appropriate.
- Deleted OpenFront accounts are suppressed and their account-derived evidence is removed across servers. Disabling player-history collection clears automatic bingo game evidence; milestone enablement is separate and still requires deletion-sync health.
- Completed/cancelled events and archived bingo boards/claims have a 90-day retention period. Terminal duel records retain 30 days; completed delivery diagnostics retain 30 days. Active records follow their feature lifecycle.
- Published Discord messages and backup snapshots have separate lifetimes. Removing database evidence does not promise to delete those artifacts.

See [statistics and history](statistics-and-history.md) for coverage/retention details and [architecture](architecture.md) for the source, database and worker contracts.

## Verify a rollout

Before registration or deployment, run `npm test` locally and follow the [operations runbook](operations.md) for the intended environment. Local tests do not establish live Discord rendering, permissions or upstream availability.

In a test server, check the member and officer views separately: save availability, publish and join an event, opt into a reminder, open onboarding, spin a package, review milestone settings, publish a bingo board and review a manual claim, then accept a duel and refresh its saved result. Confirm that private details remain private and that the public controls work after restarting the bot.

## Find a live lobby

A manager enables `/lobby configure enabled:true channel:#lobby-alerts`. Members save preferences with `/lobby watch`, using map, mode, category and/or current player-count bounds. The bot sends a DM when all selected conditions match. If Discord blocks the DM, it pings the member in the fallback channel with instructions to enable DMs.

Click **Continue searching** within three minutes of each delivered alert to keep watching. Without a click, searching stops while saved filters remain. `/lobby resume` restarts and `/lobby stop` stops immediately. `/lobby list` shows saved filters, current state and feed availability. See [lobby commands](commands.md#live-openfront-lobby-alerts) and [feed maintenance](operations.md#lobby-feed-operations).
