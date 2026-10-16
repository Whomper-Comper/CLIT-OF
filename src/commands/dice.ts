import { randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { privateReply, throttle } from "./support.js";

const CONFIG = {
  defaultSides: 6,
  minSides: 2,
  maxSides: 1000,
  animationFrames: 6,
  animationDelay: 500,
};

interface DiceDependencies {
  roll?: (minimum: number, maximumExclusive: number) => number;
  sleep?: (milliseconds: number) => Promise<unknown>;
}

export function createDiceCommand(dependencies: DiceDependencies = {}) {
  const roll = dependencies.roll ?? randomInt;
  const pause = dependencies.sleep ?? sleep;
  return {
    data: new SlashCommandBuilder()
      .setName("dice")
      .setDescription("Roll a customizable dice!")
      .addIntegerOption((option) => option
        .setName("sides")
        .setDescription("Number of sides (default: 6)")
        .setMinValue(CONFIG.minSides)
        .setMaxValue(CONFIG.maxSides)),

    async execute(interaction: ChatInputCommandInteraction): Promise<void> {
      const sides = interaction.options.getInteger("sides") ?? CONFIG.defaultSides;
      if (!Number.isSafeInteger(sides) || sides < CONFIG.minSides || sides > CONFIG.maxSides) {
        await interaction.reply({ content: "Invalid dice size!", ...privateReply });
        return;
      }
      throttle(`dice:${interaction.user.id}`, 4000);
      const result = roll(1, sides + 1);
      await interaction.deferReply();
      for (let frame = 0; frame < CONFIG.animationFrames; frame++) {
        await interaction.editReply(`🎲 Rolling${".".repeat((frame % 3) + 1)}`);
        await pause(CONFIG.animationDelay);
      }
      await interaction.editReply(`🎲 You rolled a **${result}** (D${sides})!`);
    },
  };
}

export const diceCommand = createDiceCommand();
