import { SlashCommandStringOption, type ChatInputCommandInteraction, type CommandInteractionOption } from 'discord.js';
import { CommandError } from '../commandError.js';

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

function inputOptions(options: readonly CommandInteractionOption[]): CommandInteractionOption[] {
  return options.flatMap(option => option.options ? inputOptions(option.options) : [option]);
}

/** Validate inputs synchronously before any replies, permission lookups or state changes. */
export function commandAction<T extends CommandActions>(options: ChatInputCommandInteraction['options'], actions: T): keyof T & string {
  const action = options.getString('action') ?? options.getSubcommand(false);
  if (!action || !Object.hasOwn(actions, action)) throw new CommandError('Choose a supported command action.');
  const rule: ActionInputs = actions[action];
  const allowed = new Set(['action', ...(rule.required ?? []), ...(rule.optional ?? [])]);
  for (const input of inputOptions(options.data)) {
    if (!allowed.has(input.name) && input.value !== null && input.value !== undefined) {
      throw new CommandError(`The ${action} action does not accept the ${input.name} input.`);
    }
  }
  for (const name of rule.required ?? []) {
    if (options.get(name)?.value == null) {
      throw new CommandError(`The ${name} input is required for the ${action} action.`);
    }
  }
  return action as keyof T & string;
}
