import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { privateReply, throttle } from "./support.js";

const CONFIG = {
  defaultSides: 6,
  defaultCount: 1,
  minSides: 1,
  maxSides: 1000,
  maxDice: 25,
  animationFrames: 5,
  animationDelay: 600,
  criticalMinSides: 3,
};

interface DiceDependencies {
  roll?: (minimum: number, maximumExclusive: number) => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

function formatRoll(value: number, sides: number): string {
  if (sides < CONFIG.criticalMinSides) return `**${value}**`;
  if (value === sides) return `**${value}** 🎉 CRITICAL MAX!`;
  if (value === 1) return `**${value}** 💀 CRITICAL MIN!`;
  return `**${value}**`;
}

export function createDiceCommand(dependencies: DiceDependencies = {}) {
  const roll = dependencies.roll ?? randomInt;
  const pause = dependencies.sleep ?? sleep;
  return {
    data: new SlashCommandBuilder()
      .setName("dice")
      .setDescription("Roll one or multiple dice!")
      .addIntegerOption((option) => option
        .setName("sides")
        .setDescription("Sides per die (default: 6)")
        .setMinValue(CONFIG.minSides)
        .setMaxValue(CONFIG.maxSides))
      .addIntegerOption((option) => option
        .setName("count")
        .setDescription("Number of dice (default: 1)")
        .setMinValue(1)
        .setMaxValue(CONFIG.maxDice)),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      const sides = interaction.options.getInteger("sides") ?? CONFIG.defaultSides;
      const count = interaction.options.getInteger("count") ?? CONFIG.defaultCount;
      if (!Number.isSafeInteger(sides) || !Number.isSafeInteger(count)
        || sides < CONFIG.minSides || sides > CONFIG.maxSides
        || count < 1 || count > CONFIG.maxDice) {
        await interaction.reply({ content: "❌ Invalid dice configuration!", ...privateReply });
        return;
      }
      throttle(`dice:${interaction.user.id}`, 4000);
      const rolls = Array.from({ length: count }, () => roll(1, sides + 1));
      const total = rolls.reduce((sum, result) => sum + result, 0);
      await interaction.deferReply();
      for (let frame = 0; frame < CONFIG.animationFrames; frame++) {
        await interaction.editReply(`🎲 Rolling${".".repeat((frame % 3) + 1)}`);
        await pause(CONFIG.animationDelay);
      }
      const heading = `🎲 **Rolled ${count}d${sides}!**\n\n`;
      if (count === 1) {
        await interaction.editReply(`${heading}Result: ${formatRoll(rolls[0]!, sides)}`);
        return;
      }
      const formattedRolls = rolls
        .map((result, index) => `**Die ${index + 1}:** ${formatRoll(result, sides)}`)
        .join("\n");
      const criticalMaxCount = sides >= CONFIG.criticalMinSides
        ? rolls.filter((result) => result === sides).length : 0;
      const criticalMinCount = sides >= CONFIG.criticalMinSides
        ? rolls.filter((result) => result === 1).length : 0;
      let summary = "";
      if (criticalMaxCount > 0) summary += `\n🎉 Critical Max: ${criticalMaxCount}`;
      if (criticalMinCount > 0) summary += `\n💀 Critical Min: ${criticalMinCount}`;
      await interaction.editReply(`${heading}${formattedRolls}\n\n**Total: ${total}**${summary}`);
    },
  };
}

export const diceCommand = createDiceCommand();
