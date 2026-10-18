import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  TextInputBuilder, TextInputStyle, escapeMarkdown,
} from 'discord.js';
import { CommandError } from '../commandError.js';
import type { WheelPreset } from '../community/wheelPresets.js';
import type { PrivateCommunitySession } from '../community/sessions.js';

const safe = (value: string) => escapeMarkdown(value).replace(/@/g, '＠');
const yes = (value: boolean) => value ? 'yes' : 'no';
export function wheelSettings(p: WheelPreset, map: string): string {
  return `${map}; ${p.mode}; Teams: ${p.teams ?? 'none'}; ${p.difficulty}; ${p.bots} bots; Nations: ${p.nations}; ` +
    `Size: ${p.mapSize}; Disabled: ${p.disabledUnits.join(', ') || 'none'}; ` +
    `Gold donations: ${yes(p.donateGold)}; Troop donations: ${yes(p.donateTroops)}; ` +
    `Spawn: ${p.randomSpawn ? 'Random' : 'Manual'}; Infinite gold: ${yes(p.infiniteGold)}; ` +
    `Infinite troops: ${yes(p.infiniteTroops)}; Instant build: ${yes(p.instantBuild)}`;
}
export function wheelCard(p: WheelPreset, map: string) {
  return new EmbedBuilder().setColor(0x5865f2).setTitle(safe(p.name))
    .setDescription(safe(p.instructions) || 'Apply this package when hosting in OpenFront.')
    .addFields({ name: 'Suggested hosting settings', value: safe(wheelSettings(p, map)) })
    .setFooter({ text: 'Compatible curated settings · Competitive balance is not guaranteed · Human hosting required' });
}
export function wheelButton(id: string, text: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(id).setLabel(text).setStyle(style);
}
export interface WheelEditor { preset: WheelPreset; expected: number; remove?: boolean }
export function wheelPreview(session: PrivateCommunitySession) {
  const data = session.data as WheelEditor;
  const p = data.preset;
  const actions = data.remove ? [['remove', 'Remove preset']] : [
    ['basics', 'Edit basics'], ['hosting', 'Edit hosting'], ['options', 'Edit options'],
    ['toggle', p.enabled ? 'Disable preset' : 'Enable preset'], ['save', 'Save preset'],
  ];
  return {
    embeds: [wheelCard(p, p.maps.join(', ')).addFields({ name: 'Private preview',
      value: `${p.enabled ? 'Enabled' : 'Disabled'} · Revision ${data.expected}\n${data.remove ? 'Confirm removal below.' : 'Edits are only saved when you press Save preset.'}` })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...actions.map(([action, text]) =>
      wheelButton(`wheel:${session.id}:${action}`, text, action === 'remove' ? ButtonStyle.Danger : ButtonStyle.Secondary)))],
    allowedMentions: { parse: [] as never[] },
  };
}

type Field = [string, string, string, number, string?];
export function wheelModal(id: string, section: string, p: WheelPreset) {
  let fields: Field[];
  if (section === 'basics') fields = [
    ['name', 'Preset name', p.name, 80],
    ['maps', 'Maps, separated by commas', p.maps.join(', '), 300, 'World, Europe, Black Sea, Caribbean'],
    ['mode', 'Mode: Team or Free For All', p.mode, 20],
    ['teams', 'Teams: 2–400, named type, or none', String(p.teams ?? 'none'), 30, '2, Duos, Trios, Quads, Humans Vs Nations, none'],
    ['difficulty', 'Difficulty: Easy, Medium, Hard, Impossible', p.difficulty, 20],
  ];
  else if (section === 'hosting') fields = [
    ['bots', 'Bots: 0–400', String(p.bots), 3],
    ['nations', 'Nations: default, disabled, or 1–400', String(p.nations), 8],
    ['mapSize', 'Map size: Normal or Compact', p.mapSize, 7],
    ['disabledUnits', 'Disabled units, comma separated; none allowed', p.disabledUnits.join(', ') || 'none', 300, 'Atom Bomb, Hydrogen Bomb, MIRV, MIRV Warhead'],
    ['instructions', 'Hosting instructions', p.instructions, 1000],
  ];
  else fields = [
    ['donateGold', 'Allow gold donations? yes/no', yes(p.donateGold), 3],
    ['donateTroops', 'Allow troop donations? yes/no', yes(p.donateTroops), 3],
    ['randomSpawn', 'Random spawn? yes/no', yes(p.randomSpawn), 3],
    ['resources', 'Infinite resources: none/gold/troops/both', p.infiniteGold ? p.infiniteTroops ? 'both' : 'gold' : p.infiniteTroops ? 'troops' : 'none', 6],
    ['instantBuild', 'Instant build? yes/no', yes(p.instantBuild), 3],
  ];
  const modal = new ModalBuilder().setCustomId(`wheel:${id}:apply-${section}`).setTitle('Edit wheel preset');
  for (const [key, label, value, max, placeholder] of fields) {
    const input = new TextInputBuilder().setCustomId(key).setLabel(label).setMaxLength(max)
      .setStyle(max > 100 ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(key !== 'instructions');
    if (value) input.setValue(value);
    if (placeholder) input.setPlaceholder(placeholder);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}
export function readWheelForm(p: WheelPreset, section: string, read: (key: string) => string): WheelPreset {
  const text = (key: string) => read(key).trim();
  const numberOrText = (key: string) => /^\d+$/.test(text(key)) ? Number(text(key)) : text(key);
  const boolean = (key: string) => {
    if (!['yes', 'no'].includes(text(key).toLowerCase())) throw new CommandError('Enter yes or no for each option.');
    return text(key).toLowerCase() === 'yes';
  };
  if (section === 'basics') return {
    ...p, name: text('name'), maps: text('maps').split(',').map(value => value.trim()),
    mode: text('mode') as WheelPreset['mode'],
    teams: text('teams') === 'none' ? null : numberOrText('teams') as WheelPreset['teams'],
    difficulty: text('difficulty') as WheelPreset['difficulty'],
  };
  if (section === 'hosting') return {
    ...p, bots: Number(text('bots')), nations: numberOrText('nations') as WheelPreset['nations'],
    mapSize: text('mapSize') as WheelPreset['mapSize'],
    disabledUnits: text('disabledUnits') === 'none' || !text('disabledUnits') ? [] : text('disabledUnits').split(',').map(value => value.trim()),
    instructions: read('instructions'),
  };
  const resources = text('resources').toLowerCase();
  if (!['none', 'gold', 'troops', 'both'].includes(resources)) throw new CommandError('Choose infinite resources: none, gold, troops, or both.');
  return { ...p, donateGold: boolean('donateGold'), donateTroops: boolean('donateTroops'),
    randomSpawn: boolean('randomSpawn'), infiniteGold: ['gold', 'both'].includes(resources),
    infiniteTroops: ['troops', 'both'].includes(resources), instantBuild: boolean('instantBuild') };
}
