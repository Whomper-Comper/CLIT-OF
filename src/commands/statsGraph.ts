/** Fixed columns inside a Discord code block keep graphs aligned on desktop and mobile. */
export function alignedBarChart(rows: { name: string; value: bigint | null; partial?: boolean }[]): string {
  const max = rows.reduce((max, row) => row.value !== null && row.value > max ? row.value : max, 0n);
  const lines = rows.map(({ name, value, partial }) => {
    const filled = value === null || max === 0n ? 0 : Number((value * 10n + max / 2n) / max);
    const bar = value === null ? "----------" : "█".repeat(filled) + "░".repeat(10 - filled);
    const raw = value?.toString();
    const number = value === null ? "N/A" : raw!.length <= 6 ? value.toLocaleString("en-US")
      : `~${raw![0]}.${raw!.slice(1, 3)}e${raw!.length - 1}`;
    return `${name.slice(0, 13).padEnd(13)} ${bar} ${(number + (partial && value !== null ? "+" : "")).padStart(9)}`;
  });
  return "```text\n" + lines.join("\n") + "\n```";
}
