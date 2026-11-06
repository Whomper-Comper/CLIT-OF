import { SlashCommandStringOption, type ChatInputCommandInteraction } from 'discord.js';
import { commandAction as validateAction } from './action.js';

interface ActionInputs {
  required?: readonly string[];
  optional?: readonly string[];
}
export type CommandActions = Record<string, ActionInputs>;

/** Registration and input validation share the same supported action inventory. */
export function actionOption(actions: CommandActions): SlashCommandStringOption {
  return new SlashCommandStringOption().setName('action').setDescription('Choose the command action')
    .setRequired(true).addChoices(...Object.keys(actions).map(value => ({ name: value, value })));
}

/** Validate inputs synchronously before any replies, permission lookups or state changes. */
export function commandAction<T extends CommandActions>(options: ChatInputCommandInteraction['options'], actions: T): keyof T & string {
  const rules = Object.fromEntries(Object.entries(actions).map(([name, rule]) => [name, {
    required: rule.required, allowed: [...(rule.required ?? []), ...(rule.optional ?? [])],
  }]));
  return validateAction(options, rules) as keyof T & string;
}
