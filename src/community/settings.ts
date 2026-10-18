import type { DatabaseSync } from "node:sqlite";
import { CommandError } from "../commandError.js";
import { withCommunityTransaction } from "./transactions.js";
import { validateMilestoneThresholds } from "./milestoneCounters.js";

export interface CommunitySettings {
  guildId: string; revision: number; milestonesEnabled: boolean; milestoneChannelId: string | null;
  gameThresholds: string[]; winThresholds: string[];
}
export class CommunitySettingsStore {
  constructor(private readonly sql: DatabaseSync) {}
  get(guildId: string): CommunitySettings {
    const row = this.sql.prepare("SELECT * FROM community_settings WHERE guild_id=?").get(guildId);
    return row ? { guildId, revision: Number(row.revision), milestonesEnabled: !!row.milestones_enabled,
      milestoneChannelId: row.milestone_channel_id as string | null,
      gameThresholds: JSON.parse(String(row.game_thresholds)), winThresholds: JSON.parse(String(row.win_thresholds)) } :
      { guildId, revision: 0, milestonesEnabled: false, milestoneChannelId: null,
        gameThresholds: ["10", "50", "100", "250", "500"], winThresholds: ["1", "10", "25", "50", "100"] };
  }
  list(): CommunitySettings[] {
    return this.sql.prepare("SELECT guild_id FROM community_settings ORDER BY guild_id").all().map(row => this.get(String(row.guild_id)));
  }
  save(guildId: string, draft: Omit<CommunitySettings, "guildId" | "revision">, expectedRevision: number): CommunitySettings {
    validateMilestoneThresholds({ games: draft.gameThresholds, wins: draft.winThresholds });
    if (typeof draft.milestonesEnabled !== "boolean" || (draft.milestoneChannelId !== null && (typeof draft.milestoneChannelId !== "string" || !draft.milestoneChannelId))) throw new CommandError("Choose a valid milestone channel and announcement setting.");
    if (draft.milestonesEnabled && !draft.milestoneChannelId) throw new CommandError("Milestone announcements require a channel.");
    return withCommunityTransaction(this.sql, () => {
      if (this.get(guildId).revision !== expectedRevision) throw new CommandError("Community settings changed in another session. Reopen the menu.");
      this.sql.prepare(`INSERT INTO community_settings(guild_id,revision,milestones_enabled,milestone_channel_id,game_thresholds,win_thresholds)
        VALUES(?,1,?,?,?,?) ON CONFLICT(guild_id) DO UPDATE SET revision=community_settings.revision+1,
        milestones_enabled=excluded.milestones_enabled,milestone_channel_id=excluded.milestone_channel_id,
        game_thresholds=excluded.game_thresholds,win_thresholds=excluded.win_thresholds`)
        .run(guildId, Number(draft.milestonesEnabled), draft.milestoneChannelId, JSON.stringify(draft.gameThresholds), JSON.stringify(draft.winThresholds));
      return this.get(guildId);
    });
  }
}
