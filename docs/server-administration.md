# Server administration

This guide covers configuration and routine clan management inside Discord. For installation, running the service and command registration, use [operations](operations.md). The [command reference](commands.md) lists every input and cooldown; [statistics and history](statistics-and-history.md) explains reports and collection; [architecture](architecture.md) explains the implementation. Return to the [README](../README.md) for the project overview.

## Contents

- [Bootstrap access](#bootstrap-access)
- [Prepare Discord roles and channels](#prepare-discord-roles-and-channels)
- [Configure the first clan](#configure-the-first-clan)
- [Link members correctly](#link-members-correctly)
- [Understand synchronization](#understand-synchronization)
- [Closed-clan approvals and invitations](#closed-clan-approvals-and-invitations)
- [Review membership, coverage and audit](#review-membership-coverage-and-audit)
- [Use diagnostics and debug tools](#use-diagnostics-and-debug-tools)
- [Enable history and weekly recaps](#enable-history-and-weekly-recaps)
- [Milestone announcements](#milestone-announcements)
- [Change or remove clan configurations](#change-or-remove-clan-configurations)
- [Permission and role troubleshooting](#permission-and-role-troubleshooting)
- [Source map](#source-map)
- [Community release setup](#community-release-setup)

## Bootstrap access

There are two independently selected access roles:

| Role | Grants |
| --- | --- |
| Config role | All clan actions, plus `/config` and configuration edits |
| Debug role | `/debug` status/export and verbose/private-response settings |

Manage Server permission grants `/config` access even if the config role is missing or deleted. It does **not** bypass the config role for other `/clan` actions. `/debug` always requires the selected debug role, including for the server owner and administrators. The same normal role can be selected for both purposes if desired, but their settings are independent.

1. Create a normal server role for bot managers, such as `@ClanManager`, and assign it to the people who should manage clans.
2. A member with **Manage Server** opens `/config`.
3. Open **Access** and select that role in **Set config role (saves immediately)**. The role must not be `@everyone` or an integration-managed role. Selecting it grants access to holders; it does not assign the role to anyone.
4. Optionally create/select a separate debug role and give it to people allowed to export identity associations. Its selector saves immediately. Clear it to disable `/debug`.
5. Confirm the Access page displays the intended roles. A person without Manage Server can lose configuration access immediately if they change the config role to one they do not hold.

If no one holds the saved role or it was deleted, a Manage Server member can reopen `/config` and choose a replacement. Previously opened menus cannot retain revoked access: actions refresh membership and permissions. All menu sessions are private, belong to their opener, expire after 10 minutes and disappear from process memory on restart.

## Prepare Discord roles and channels

For each clan, decide which existing Discord roles to map:

| Mapping | Required? | Result |
| --- | --- | --- |
| Member | Yes | Every linked member confirmed in the clan earns this role |
| Officer | No | Officers and the leader also earn this role |
| Leader | No | Only the leader also earns this role |
| Approval (`join_role`) | No | Staff assign it to indicate approval for joining; it supports pending-invite reports |
| Log channel | No | Text channel for role-change and invitation notices |

Member, officer and leader must be different roles within a clan. Approval must differ from those three. All selected roles must exist and be normal roles, excluding `@everyone` and integration roles. Config validation does not require the approval role to sit below the bot because staff own it; each role the bot assigns/removes must sit below the bot's highest role.

Give the bot **Manage Roles**, then put its role above the member/officer/leader roles in **Server Settings → Roles**. For logs, choose a server text channel where the bot has **View Channel**, **Send Messages**, and **Embed Links**. A weekly-recap channel additionally needs **Read Message History**. Administrator permission is not required by the implementation.

The bot requests Discord's Guilds and privileged Guild Members intents. Enable the Members intent for the application as described in [operations](operations.md); complete membership fetches are used for synchronization, reports, exports and configuration changes.

Roles may be shared across different clans. The bot calculates earned roles across all configured memberships before removing a shared role. Use dedicated approval roles: they are staff-owned and preserved by queued cleanup when still configured as approvals. Avoid giving the same role conflicting duties across clans unless that ownership behavior is intended.

## Configure the first clan

### Recommended menu workflow

1. Open `/config`, choose **Clans**, then **New clan**.
2. Open **Tag / sync interval**. Enter a tag of 2–5 letters or digits without brackets; it is trimmed and uppercased. Enter an integer sync interval from 2 to 1440 minutes. New drafts use `DEFAULT_SYNC_INTERVAL_MINS`, normally 10 minutes.
3. Open **Roles** and select Member plus optional Officer, Leader and Approval mappings. Optional selectors can be cleared. Choose **Back** to return to General.
4. Open **Logging**, optionally select a text channel, then return or save.
5. Review the exact tag and choose **Create clan**. The bot refreshes Discord permissions and checks for concurrent changes before saving. OpenFront's public clan statistics endpoint cannot verify a tag, so double-check its spelling in the game.
6. Run `/clan action:doctor clan_tag:MARS`, then `/clan action:sync clan_tag:MARS` to inspect initial behavior. These slash actions require the selected config role, even if you created the configuration using Manage Server permission.

An existing clan saves valid role, log channel, and interval edits immediately. Rank or approval role changes can queue reconciliation. Logging and interval changes preserve the last sync time and avoid extra reconciliation. **Cancel** discards an incomplete new clan draft.

Select an existing clan on the Clans page to edit it. Its selector displays up to 25 clans per page. An existing tag cannot be renamed in place; configure the replacement tag and remove the old configuration if a tag changes. Concurrent edits are rejected rather than silently overwriting saved state. Reopen the clan and reapply the intended changes after a conflict.

### Equivalent slash setup

```text
/clan action:setup clan_tag:MARS member_role:@MarsMember officer_role:@MarsOfficer leader_role:@MarsLeader join_role:@Approved log_channel:#clan-log sync_interval:10
```

`action:setup` requires the config role, `clan_tag` and `member_role`. It applies the same tag format and Discord mapping checks. **It replaces the whole configuration for that tag.** Omitted optional roles/log channel become empty, and an omitted interval returns to the environment default. Use the menu when changing only one setting.

Saved settings can be inspected privately with `/clan action:config clan_tag:MARS`. `/clan action:config` without a tag or page opens the menu; adding `page` requests saved settings instead, three clans per page. Manage Server permission or the config role permits both forms.

## Link members correctly

### Verified bot-wide identity

Ask members to run one of:

```text
/link openfront_id:https://openfront.io/player/HabCsQYR
/link token:<their Identity Token>
```

The ID/profile route succeeds only when OpenFront's live Discord connection matches the caller. Otherwise, the member generates an Identity Token in OpenFront account settings and submits it using the private token route. Exactly one field is required. Names alone are not identity proof.

A verified link works throughout configured servers. It takes precedence over server approvals. Verifying ownership removes the owner's old local approvals and conflicting local claims to the verified account, queues reconciliation, and resets associated identity history. An account already verified to another Discord user remains protected until its owner unlinks it.

### Server-only manual approval

When staff intentionally approve a member without bot-wide verification:

```text
/clan action:link user:@Alice openfront_id:HabCsQYR
```

The caller needs the config role, the target must be a human current server member, and the OpenFront profile must exist. The record is an `admin_manual` link scoped to this server. It does not prove ownership for other servers. A manual link cannot replace a verified Discord identity or claim an already-verified OpenFront ID. Within one server, the same OpenFront account cannot be manually assigned to two people.

Managers may replace a member's eligible manual link with a new manual approval. The action records the actor and old/new IDs, purges affected member history, and queues reconciliation.

### Removing links

| Intent | Action |
| --- | --- |
| Member removes all their bot-wide and server approvals everywhere | Member runs `/unlink` |
| Manager removes a manual approval only in this server | `/clan action:unlink user:@Alice` |
| Manager tries to remove a verified identity | Refused; only the owner can use `/unlink` |

Self-unlink also works outside servers and purges associated identity history. Cleanup is queued and paced; the response is not a promise that every Discord role has already changed. The bot does not automatically remove staff approval roles.

Use `/whois user:@Alice` to inspect effective link scope and live clans. This lookup is public. Manual and verified links both support synchronization and current-server reports when effective here; only verified links are available bot-wide.

## Understand synchronization

The scheduler checks due clan configurations every minute. Each clan's saved interval controls when another full pass is due; the interval is not a hard real-time deadline. Full passes load current members, skip bots and reconcile those with effective links. A linked member joining the server triggers member synchronization. Link, unlink and configuration changes also enqueue persistent reconciliation/cleanup work.

Role operations are paced one at a time with a one-second pacing interval, so large passes take time. Queue work checks current identity/configuration before mutations and retries failures. The bot does not treat an unavailable profile, omitted membership field or changed configuration as proof that a player left: it reports an error and skips unsafe stale updates. Other successful operations can have completed before a later failure; inspect the reported changes and failed checks.

| Confirmed membership | Desired mapped roles |
| --- | --- |
| Member | Member |
| Officer | Member + configured Officer |
| Leader | Member + configured Officer + configured Leader |
| Not in clan | Remove roles earned only by this clan, preserving any still earned through another configured clan |

Sync does not edit in-game memberships. It reflects live OpenFront membership into Discord. A server approval/identity link alone does not earn member roles until actual clan membership is confirmed.

### Run and read a manual sync

```text
/clan action:sync clan_tag:MARS
/clan action:sync clan_tag:MARS user:@Alice
/clan action:sync page:2
```

A full sync is public and displays a progress message, followed by member/clan totals, role changes and failed checks. A targeted sync follows ordinary reply privacy settings and requires that member's current effective link. It can select one tag or the requested page of clans.

**Only the selected page is processed, at most 10 clans.** On servers with more than 10 configured clans, invoke subsequent pages or select individual tags. Whole-server sync has a 60-second server cooldown; member sync has a 10-second server/target cooldown.

The saved last-sync timestamp advances after a full clan pass with no member errors, including a manually requested full pass; a targeted member pass does not update that clan timestamp. Some diagnostics label this value as a scheduled sync, but it is not exclusively proof of a scheduler-triggered run. A pass with no linked members can also complete successfully.

Check `/debug action:status` for queued/retrying work if holding the debug role. A completed manual pass does not mean the separate persistent job queue is empty.

## Closed-clan approvals and invitations

An approval role is a staff signal to invite someone in OpenFront; the bot does not send the in-game invitation.

1. Configure a distinct Approval role and optional log channel for the clan.
2. Staff give the approval role to the Discord member.
3. If they are unlinked, the role-add event can post a log notice asking them to use `/link`.
4. If linked and already in the clan, the bot synchronizes their mapped roles. If linked but not in the clan, it can post their profile and an instruction for officers to invite/accept them in-game.
5. Officers perform that action in OpenFront. After membership appears in the API, run targeted sync or wait for the next pass.

```text
/clan action:pending clan_tag:MARS page:1
```

Pending lists current human members holding the configured approval role whose membership is not yet confirmed, including unlinked users marked as needing `/link`. It has 15 entries per page and can combine clans when no tag is supplied. Without any selected approval-role configuration, the action explains that one is needed. If a linked pending user's profile or membership is unavailable, the action fails rather than presenting that uncertainty as confirmed non-membership.

Full synchronization can post a combined pending-invitation notice in the configured log channel. The approval role remains under staff control after joining or unlinking; remove it manually when your workflow requires that. Log messages can contain mention text, but global allowed-mention settings suppress automatic mention parsing, so do not assume they ping officers.

## Review membership, coverage and audit

### Roster

```text
/clan action:roster clan_tag:MARS page:1
```

Roster is public and requires a clan tag and config role. It checks effective links for people currently in this server, fetches profiles with bounded concurrency, confirms membership and sorts matching members by name. It shows up to 15 per page, role-mismatch markers and unavailable-profile counts.

A rank role also configured as an approval role for another clan is protected from removal and does not produce a surplus-role warning. Missing earned ranks and other surplus rank roles still receive mismatch markers.

It is **not** the full OpenFront clan member list, a list of everyone holding a Discord role, or proof that an omitted player is not in the clan. Unlinked players, people outside the server and unavailable profiles are outside confirmed roster rows. Roster only reports; run sync to reconcile roles.

### Link coverage

```text
/clan action:coverage
/clan action:coverage clan_tag:MARS
```

Coverage compares linked current human Discord members against all current human members, excluding bots. For each selected clan it counts confirmed clan members linked in this server. The public API does not supply the full clan size or roster for this report.

Profile checking is limited to the first 250 linked humans with a 90-second work deadline and up to five concurrent workers. Unavailable or unchecked profiles make clan counts partial. Public results may be cached for up to 15 seconds. Each report page covers up to 10 clans, and its Discord link totals cover the whole server.

After those requests, coverage refreshes server membership and links before calculating its totals. Departed members and removed links no longer contribute; newly linked or reverified identities count as unchecked until another report. If the final membership refresh fails, no report is released.

### Link audit

```text
/clan action:audit
/clan action:audit user:@Alice page:2
```

Audit shows link events recorded for this server, 10 per page: actor, target, time, event name and old/new IDs. An empty later page is allowed. Selecting yourself additionally includes your global link/unlink and legacy manual-revocation events regardless of recorded origin; other-server manual approval events remain scoped away. This action still requires the config role. The log is a link-change audit, not Discord's complete role audit trail or a full configuration-change log.

## Use diagnostics and debug tools

```text
/clan action:doctor
/clan action:doctor clan_tag:MARS page:1
```

Doctor refreshes role state and bot permissions, validates mappings and hierarchy, checks log and weekly channel permissions, and reports role queue and history/Elo health. For up to five clans shown on a page, it makes one uncached request to sample public clan session history. That checks the endpoint's response for the sample. Use the clan tag shown in OpenFront to verify spelling.

Queued retries count as issues. A role job eligible for over 15 minutes is flagged. A saved clan timestamp older than `max(15 minutes, three configured sync intervals)` is flagged overdue. With no clans configured, API clan reachability cannot be established through this report. General status and issue counts are for the displayed page and current checks.

The `/config` home **Diagnostics** and **Link coverage** buttons provide private first-page reports to configuration users, including Manage Server users who do not hold the clan role. For later pages, use slash reports with the config role. These reports share their 15-second action/server cooldowns.

Both entry points check access again after loading. Changed clan mappings, access settings or history settings require a fresh report; configuration-menu reports also stop if the menu expires. Coverage is withheld if human membership or linked identities in this server change during the final access check.

The debug role permits:

```text
/debug action:status
/debug action:export_links
/debug action:verbose enabled:true
/debug action:ephemeral enabled:false
```

Status privately reports links, membership, queues and history indicators. Export privately downloads complete current-server effective link associations as JSON; it requires a complete member fetch, rechecks access and rejects files exceeding the attachment limit. Treat the downloaded account associations as administrative data. Debug membership/export filtering is not identical to coverage's human-only denominator.

Verbose mode adds safe explanations for known errors (default off). Set it back with `enabled:false`. Ordinary replies default to private; ephemeral false makes ordinary clan/unlink replies public, while verification/configuration/debug and pre-acknowledgement access rejections stay private. Roster, whole-clan sync, whois, stats and valid dice responses are already public. Existing messages retain their original visibility. See [commands](commands.md#visibility-and-permissions) for the full behavior.

## Enable history and weekly recaps

Open `/config` → **Match history / weekly recap**. New servers have clan/player history enabled, collection/weekly delivery disabled, a 15-minute collection interval, 90-day retention and Monday 12:00 UTC delivery settings.

Choose the desired history/collection toggles and destination, then **Timing / retention** for the collection interval (5–1440 minutes), retention (14–365 days), weekly day (0 Sunday–6 Saturday), hour (0–23) and valid IANA time zone. Choose **Save** to persist the draft. Enabling Weekly also enables Collect; turning Collect off turns Weekly off; clearing the channel disables Weekly. The recap channel needs View Channel, Send Messages, Embed Links and Read Message History.

Use `/clan action:recent clan_tag:MARS days:7 view:both` for live recent public Team analysis. Use `/clan action:summary` to preview the collected previous completed Monday-to-Monday week in the server's configured time zone. The summary preview is distinct from scheduled delivery and does not use `days`/`clan_tag` to redefine its window. Initial collection backfills seven days; older/uncollected periods cannot be assumed complete. See [statistics and history](statistics-and-history.md) for detailed eligibility, schedule and data limits.

## Change or remove clan configurations

Changes to mappings can leave obsolete Discord roles temporarily present while reconciliation runs. Save queues affected linked users and holders of old managed roles; cleanup evaluates current mappings rather than blindly deleting every previous role. Shared roles that are still earned are preserved.

For removal, open the saved clan in `/config` → **Delete** → **Confirm removal**. This removes the configuration and queues obsolete-role cleanup. **Keep clan** cancels deletion. Alternatively, `/clan action:remove clan_tag:MARS` applies removal without a second confirmation. Removing a configuration does not unlink member identities or disband the OpenFront clan. Staff approval-role cleanup remains staff-owned.

## Weekly availability

Members manage their own schedules with `/availability action:set`, `/availability action:view`, and `/availability action:clear`. Personal schedules and edit menus stay private. Community officers (the configured manager role or an officer/leader role mapped to a configured clan) can use `/availability action:view user:@Member`; the bot fetches current roles for each privileged command or control. Existing configuration, clan and debug access rules remain unchanged.

`/availability action:suggest` publishes counts and viewer-local Discord timestamps, with a fresh membership refresh and no private schedule details. The bot stores IANA timezones and local weekly windows so seasonal offset changes follow the member's timezone. Members who leave the server lose that server's availability; unlinking an OpenFront account preserves recurring availability. Removing the bot from a server clears its availability records. Private menus are bound to their owner, server, channel and original message and expire in ten minutes.

Suggestions are planning aids and do not create events or enroll participants. If no session fits all saved schedules, reduce duration or ask members to broaden their windows. The Members intent must permit the current roster refresh.

## Permission and role troubleshooting

| Symptom | Checks and recovery |
| --- | --- |
| Owner/administrator cannot use clan actions | Hold the configured manager role; Manage Server only grants configuration access |
| `/debug` denied | Check selected debug role and actual role assignment; owners/admins have no bypass |
| Config role deleted/no holders | A Manage Server member selects a replacement in `/config` and assigns it |
| Save rejected for role permissions | Give bot Manage Roles and move its highest role above all member/officer/leader mappings |
| Save rejected for duplicate/invalid roles | Select distinct member/officer/leader mappings and a different approval role; exclude `@everyone` and integration roles |
| Log/recap channel inaccessible | Verify current text-channel type, channel permission overrides and view/send/embed permissions; recap also requires read history |
| Cannot fetch all members/export/coverage | Verify Members intent, bot installation and Discord connectivity; retry after availability recovers |
| Sync finds no member roles to grant | Confirm effective link with whois, actual live clan membership and selected tag; approval alone does not grant membership |
| Sync fails or leaves old roles | Run doctor; inspect permission/hierarchy failures, upstream membership availability and pending/retrying jobs |
| Manual approval rejected as verified | Member owns changes to verified identity via link/unlink; manager cannot override it |
| No invitation alert | Confirm approval-role mapping and actual role-add event, log destination access and API availability; use pending to inspect current state |
| Menu expired/conflicting edit | Reopen `/config` and repeat from current saved configuration |
| Public roster incomplete | Check unavailable-profile count, links and server membership; public roster is not the full clan list |
| History/Elo blank or retrying | Check feature toggles, collection, retained coverage and upstream errors; doctor/status give indicators |

If commands are missing, registration or application availability needs attention rather than clan settings. If jobs remain overdue after permissions and API access recover, give the maintainer the action, approximate time and doctor/status findings; use [operations](operations.md) for service/log checks. Never include Identity Tokens or bot credentials in that report.

## Community event administration

Event creation, editing, cancellation, squad management and private suggestion drafts require the configured manager role or a configured clan's officer/leader role. Privileged controls refresh membership and reread role mappings on every use. These community permissions do not change the existing clan, config or debug access rules.

Events publish through the shared delivery worker. The saved draft exists before the bot posts; a successful post is bound to that exact revision and message. Public signup controls work only on that canonical message. Other views link back to it. Card updates coalesce pending changes and edit the saved message rather than posting another event.

Use `/event action:edit` to inspect paused or uncertain publication jobs. Correct missing channel permissions before retrying a paused delivery. A post with an uncertain outcome is marked **Needs review**, and the shared worker checks recent bot messages for its recovery marker before any retry. A successful Discord post whose database binding fails also requires review; automatic ticks do not blindly post duplicates. Draft changes remain locked while publication is unresolved. Do not remove the marker manually during reconciliation.

Member departure removes active signups and marks reserve promotion due; unlinking an OpenFront account preserves unrelated event signups. Server removal clears that server's events/signups. The worker promotes present reserves, sends opted-in reminders, closes signups at the start and marks ended events finished. Bounded retention cleanup removes events and signups strictly after ninety days from the actual end or cancellation; active drafts remain saved. Use the publication recovery guidance above for paused or uncertain jobs. See [event scheduling and delivery](architecture.md#event-scheduling-and-delivery) for worker budgets and retention limits.

## Newcomer follow-up

Members enroll themselves through `/onboarding action:status`, choosing a configured clan explicitly when more than one exists. Officers inspect a member with `/onboarding action:status user:@Member` or review `/onboarding action:queue`; both views remain private and use the community manager/officer/leader access rules. Roles and mappings are refreshed on each privileged command or button, including before releasing results from remote profile lookups.

The queue contains only enrolled current human members and paginates ten at a time. One fresh roster establishes accurate current-member page counts; a final request checks only the displayed members and officer. Each page looks up at most ten linked profiles and never requests profiles for unlinked members. Navigation and Refresh have a ten-second cooldown. A membership, identity, enrollment or access change during lookup rejects stale results and asks the officer to reopen.

The checklist derives progress from the current link, fresh clan profile, availability and retained confirmed signups. Server approval alone never establishes OpenFront clan membership; an API outage shows Unknown. Completing the event step proves signup, not attendance. Unlink/account replacement resets the account-derived completion observation while preserving availability and unrelated signups; account deletion also invalidates observations. Member departure removes enrollment and server removal clears all that server's onboarding records. Same-account re-verification retains an existing completion observation but invalidates any lookup still using the old identity binding. Local facts are reevaluated on status/Refresh; completion dates record the last observed checklist completion, not a perpetual membership guarantee.

## Source map

The access rules above come from `src/access.ts`; configuration validation from `src/setupConfig.ts`; slash actions and menu behavior from `src/commands/clan.ts`, `clanHandlers.ts`, `config.ts` and `debug.ts`; effective-link protection and reconciliation enqueueing from `src/db.ts`; role calculation and scheduling from `src/roles.ts` and `src/clanSync.ts`; coverage/doctor limits from `src/reporting.ts`. Consult those sources when changing behavior and update both this guide and the [command reference](commands.md).

## Wheel preset administration

Wheel management uses the community manager/officer/leader role rules. `/wheel action:presets`, `/wheel action:add`, `/wheel action:edit` and `/wheel action:remove` always open private controls. Each privileged action refreshes membership, rereads mapped roles and rejects stale revisions. The ordinary-reply privacy setting does not make these forms public. Preset removal requires an explicit confirmation; edits and enable/disable choices require **Save preset**.

A preset is a complete compatible hosting package. Free For All must leave teams as `none`; Team requires a numeric team count or Duos, Trios, Quads, or Humans Vs Nations. Bots allow 0–400; nations allow `default`, `disabled`, or 1–400. Humans Vs Nations requires nations enabled even with zero bots. Normal/Compact map sizes, the four explicit supported maps and supported unit names are validated before preview/save. Extend these catalogs through a reviewed source change.

Each guild starts with six editable presets once. Removing all of them intentionally leaves an empty wheel; disabled/empty wheels give actionable officer guidance. Server removal clears presets and their initialization marker. Existing public spins have their own message lifetime. An officer's private draft button snapshots the chosen map/settings/instructions and cannot publish or enroll members automatically.
## Milestone announcements

Open `/milestones action:configure` with Manage Server or the configured manager role. Announcements default to off. Choose a server text or announcement channel where the bot has View Channel, Send Messages, Embed Links and Read Message History, review the games/wins thresholds, enable announcements and Save. Channel selection and toggles are drafts until saved. Each privileged action freshly checks membership and configuration access, including after destination validation.

The default public Team lifetime thresholds are games 10/50/100/250/500 and wins 1/10/25/50/100. Each metric accepts zero to ten ascending, unique positive integers; blank disables that metric. Existing earned cards remain privately visible when thresholds or announcements are disabled. Baselines and newly introduced thresholds initialize quietly; later crossings combine into one card per observed member check. An approval role alone is not current OpenFront clan membership.

Use the private delivery diagnostics and **Retry / reconcile** controls after fixing channel permissions. Uncertain sends reconcile bot-authored recovery markers; an unproven outcome stays reviewable. Saving new settings invalidates unsent deliveries captured under the old revision. Milestone enablement also keeps the account-deletion feed synchronized when match-history collection is off; an unhealthy or stale checkpoint pauses automatic polling and sending.

## Shared bingo administration

Community managers and configured clan officers/leaders manage `/bingo action:create`, `/bingo action:review` and `/bingo action:reset`; existing `/clan`, `/config` and `/debug` permissions are unchanged. Creation resumes the opener's own private draft. Review all 24 definitions, destination and optional UTC closing instant before publishing. After publication, definition changes require an explicitly confirmed reset. Reset archives the old board and cancels its pending publication/update/completion jobs; a replacement publication failure remains a recoverable draft.

Members claim manual cells privately using a cell number, explanation and optional HTTPS evidence. The bot never fetches the evidence URL. Review ten claims per page, choose a claim to read the full submission, and record approve/reject with a reason. A rejected prior approval recomputes the cell/lines and writes an audit reason. Repeated pending member/cell claims share one ID. Public cards expose only Pending/completion state, not submitters' explanations or evidence. Full challenge labels remain available with `/bingo action:view cell:…`.

Game objectives depend on enabled and healthy player history, configured tags, retained eligible public Team games and freshly fetched current human membership. Approval roles alone do not provide game evidence. Cards show observed/incomplete coverage and retention limits; partial refreshes and roster outages withhold stale automatic counts/lines. Manual work remains available with collection disabled. Availability objectives include unlinked current humans. Losing/regaining a line does not announce it twice; an explicit reset creates a new namespace.

Unpublished draft recovery uses `/bingo action:create`; active-board delivery diagnostics use `/bingo action:review`. Correct channel permissions before **Retry / reconcile**. Both flows refresh officer access. Preserve existing bot recovery markers for uncertain accepted sends; the shared worker reconciles recent messages before binding the original publication. Private sessions expire after ten minutes and stale board/claim controls require reopening. Member departure removes pending claims; archived boards/claims are cleaned in bounded batches after 90 days. Published Discord cards have their own lifetime.

## Friendly dice duels

Current human members use `/duel opponent:@member`; no officer role or OpenFront link is required. The opponent accepts/declines and the challenger cancels. Both memberships are freshly verified before acceptance. A tied result permits a new, consent-based rematch; pending limits and the challenger cooldown still apply. This feature has no stakes or ranking.

The public destination needs View Channel, Send Messages, Embed Links and Read Message History. The initial public card has disabled controls until its canonical message binding is saved. **Refresh** on an existing card retries a failed public update using its saved rolls. Correct channel permissions before retrying. A publication that has no proven canonical message is never automatically replaced after an ambiguous send. Preserve recovery markers and investigate shared delivery diagnostics rather than deleting uncertain posts and trying to force another publication.

The shared worker retains its four-send/eight-request budget each minute. A disabled publication and an enabling edit each consume one outbound slot. Publication/activation waits at most two minutes from creation; the two-minute acceptance clock starts once at durable canonical activation immediately before the enabling request. The request's duration reduces the usable window. Queue waiting plus acceptance can approach four minutes; an invitation still waiting at its original deadline expires with retry guidance. Failed/ambiguous edits and retries retain the original activation deadline.

Member departure removes pending consent and participant slots, retaining only minimal canonical transport references to close the old card. Completed public outcomes retain their 30-day record lifetime; removing an OpenFront identity does not affect these account-independent duels. Server removal clears the server's duel data and closure references.

## Community release setup

1. Configure manager and clan rank mappings. Community officers may manage events, wheel presets, onboarding queues and bingo; milestone destination/enablement requires Manage Server or manager role. Verify both kinds of access with the intended member roles.
2. Use server text/announcement destinations with View Channel, Send Messages, Embed Links and Read Message History. Event and bingo drafts use their command channel; inspect the draft and explicitly publish. A wheel draw only suggests settings for a human to host.
3. Members save their own local weekly availability and open `/onboarding action:status` to enroll. Suggestions show counts, and event signup remains separate from attendance. Reminders default off; officers choose a lead and each confirmed member opts in on the public card.
4. Announcements start disabled. Save a destination and thresholds in `/milestones action:configure` to opt in. Initial counters and newly configured thresholds baseline silently; polling uses current public Team profile totals and its own deletion-health gate, independently of match collection.
5. For automatic bingo game cells, enable player history and collection in `/config` and ensure the deletion feed is healthy. Only retained post-board observations count. Manual claims and current-human availability submissions work with collection off. Partial scans hide automatic progress until a fresh generation completes.
6. Review event management, milestone configuration, or bingo draft/review delivery status after permission failures. Correct access, reopen expired menus and deliberately **Retry / reconcile**. Preserve bot recovery markers. Needs review means an accepted send may exist; do not create another post to guess its outcome. Existing duel **Refresh** recovers a saved result without rerolling.

Unlink/replacement deletes account-derived milestone/bingo evidence and resets onboarding completion, while recurring availability, signups and account-independent duels survive. Departure removes availability/enrollment/active signups/pending claims and duel consent, and queues reserve promotion. Account deletion purges derived account evidence in every guild; disabling player-history collection clears automatic game evidence. Guild removal clears all community records. Saved Discord messages have their own lifetime and are not a substitute for current database/access checks.

## Lobby alert setup

A member with Manage Server or the configured manager role runs:

```text
/lobby action:configure enabled:true channel:#lobby-alerts
```

The bot needs View Channel, Send Messages, Embed Links and Read Message History in that ordinary server text channel. Members must be able to view it to receive fallback pings. Alerts start disabled, and watches require a configured enabled server. Changing settings stops existing searches; members explicitly restart with `/lobby action:resume`.

Members save their own filters with `/lobby action:watch name:World-teams map:World mode:Team min_players:20`. Results go to DMs first. If DMs are blocked, the bot mentions only that member in the fallback channel and tells them to enable DMs from server members. No role-wide pings or extra Message Content/Reaction intents are needed; continuation uses a button.

Every alert pauses searching until its owner clicks Continue searching within 180 seconds after delivery. Silence stops the search and keeps filters. `/lobby action:configure` without inputs privately shows delivery diagnostics and feed status. Fix channel/DM permissions, then ask the affected member to resume; a review-held lobby is not automatically resent.
