import type { ChatInputCommandInteraction } from 'discord.js';
import { CommandError } from '../commandError.js';

type Options = ChatInputCommandInteraction['options'];
interface ActionInputs {
  allowed?: readonly string[];
  required?: readonly string[];
  any?: readonly string[];
}
const integers = new Set(['cell', 'page', 'day', 'duration', 'capacity', 'reminder', 'min_players', 'max_players']);

/** Validate before permissions, cooldowns, reads or replies; old registrations may still send subcommands. */
export function commandAction(options: Options, actions: Record<string, ActionInputs>): string {
  const action = options.getString?.('action') ?? options.getSubcommand(false);
  if (!action || !Object.hasOwn(actions, action)) throw new CommandError('Choose a supported action. Refresh the command and try again.');
  const rules = actions[action];
  const supplied = new Map<string, unknown>();
  if (options.data) {
    // Discord exposes legacy options inside the subcommand wrapper, not at the command root.
    const collect = (data: Options['data']) => {
      for (const option of data) {
        if (option.type === 1 || option.type === 2) {
          if (option.options) collect(option.options);
        } else if (option.name !== 'action') supplied.set(option.name, option.value ?? option.user ?? option.channel);
      }
    };
    collect(options.data);
  } else {
    // Lightweight legacy callers may expose getters only; retain their existing interface.
    const names = new Set(Object.values(actions).flatMap(value => value.allowed ?? []));
    for (const name of names) {
      const value = integers.has(name) ? options.getInteger?.(name)
        : name === 'enabled' ? options.getBoolean?.(name)
        : name === 'user' ? options.getUser?.(name)
        : name === 'channel' ? options.getChannel?.(name) : options.getString?.(name);
      if (value != null) supplied.set(name, value);
    }
  }
  for (const name of supplied.keys()) {
    if (!rules.allowed?.includes(name)) throw new CommandError(`The ${action} action does not accept the ${name} option.`);
  }
  for (const name of rules.required ?? []) {
    if (supplied.get(name) == null) throw new CommandError(`The ${action} action requires ${name}.`);
  }
  if (rules.any && !rules.any.some(name => supplied.get(name) != null)) {
    throw new CommandError(`The ${action} action requires at least one filter: ${rules.any.join(', ')}.`);
  }
  return action;
}
