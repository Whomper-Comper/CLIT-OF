interface MemberLookup {
  get(id: string): { user: { bot: boolean } } | undefined;
}

/** Callers supply fresh links and membership; preserve link order and identity fields. */
export function humanMemberLinks<T extends { discord_id: string }>(links: readonly T[], members: MemberLookup): T[] {
  return links.filter(link => {
    const member = members.get(link.discord_id);
    return !!member && !member.user.bot;
  });
}
