import { commandAction } from './action.js';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, ButtonBuilder, EmbedBuilder, InteractionContextType, SlashCommandBuilder,
  StringSelectMenuBuilder, escapeMarkdown, type ChatInputCommandInteraction, type Interaction,
} from 'discord.js';
import { db as defaultDatabase, type BotDatabase } from '../db.js';
import { CommandError, privateReply } from './support.js';
import { CommandLimits } from '../queues.js';
import { requireCommunityOfficer, hasCommunityOfficerRole } from '../community/access.js';
import { communitySessions, type CommunitySessions } from '../community/sessions.js';
import { STARTER_PRESETS, SUPPORTED_UNITS, validateWheelPreset, type WheelPreset } from '../community/wheelPresets.js';
import { spinWheel } from '../community/wheel.js';
import type { EventDraftInput } from '../community/events.js';
import { createEventDraft } from './event.js';
import { wheelButton, wheelCard, wheelModal, wheelPreview, wheelSettings, readWheelForm, type WheelEditor } from './wheelForms.js';

interface Dependencies {
  db?: BotDatabase;
  now?: () => number;
  sessions?: CommunitySessions;
  roll?: (min: number, max: number) => number;
  createDraft?: (interaction: Interaction, seed: Partial<EventDraftInput>, assertSourceCurrent?: () => void) => Promise<void>;
}
interface Picker { remove: boolean }
export function createWheelCommand(dependencies: Dependencies = {}) {
  const database = dependencies.db ?? defaultDatabase;
  const now = dependencies.now ?? Date.now;
  const sessions = dependencies.sessions ?? communitySessions;
  const cooldowns = new CommandLimits();
  const store = database.community.wheel;
  function newSession(i: Interaction, kind: string, data: unknown, messageId: string | null = null) {
    return sessions.create({ kind, ownerId: i.user.id, guildId: i.guildId!, channelId: i.channelId!, messageId, data }, now());
  }
  function current(p: WheelPreset): WheelPreset {
    const saved = store.list(p.guildId).find(value => value.id === p.id);
    if (!saved || saved.revision !== p.revision) throw new CommandError('Preset changed or removed. Reopen /wheel action:presets.');
    return saved;
  }
  async function showEditor(i: ChatInputCommandInteraction, p: WheelPreset, remove: boolean) {
    const session = newSession(i, 'wheel-editor', { preset: p, expected: p.revision, remove } satisfies WheelEditor);
    const message = await i.editReply(wheelPreview(session));
    sessions.bind(session.id, message.id);
  }
  return {
    data: new SlashCommandBuilder().setName('wheel').setDescription('Spin curated map and hosting settings packages')
      .setContexts(InteractionContextType.Guild)
      .addStringOption(o => o.setName('action').setDescription('Spin, or manage presets privately (officers)').setRequired(true)
        .addChoices(...['spin', 'presets', 'add', 'edit', 'remove'].map(value => ({ name: value, value }))))
      .addStringOption(o => o.setName('id').setDescription('Edit/remove: preset ID, or omit to choose from a menu').setMaxLength(100)),

    async execute(i: ChatInputCommandInteraction): Promise<void> {
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use /wheel in a server.');
      const sub = commandAction(i.options, {
        spin: {}, presets: {}, add: {}, edit: { allowed: ['id'] }, remove: { allowed: ['id'] },
      });
      if (sub === 'spin') {
        if (!cooldowns.take(i.user.id, 5000, now())) throw new CommandError('Please wait five seconds before spinning again.');
        await i.deferReply();
        const member = await i.guild.members.fetch({ user: i.user.id, force: true });
        if (member.user.bot) throw new CommandError('A server member must spin the wheel.');
        const { preset, map } = spinWheel(store.list(i.guildId), dependencies.roll);
        await i.editReply({ embeds: [wheelCard(preset, map)], components: [], allowedMentions: { parse: [] } });
        if (hasCommunityOfficerRole(i.guildId, member, database)) {
          const settingsText = wheelSettings(preset, map);
          if (settingsText.length > 500) throw new CommandError('This hosting package exceeds the event settings budget. Ask an officer to shorten its disabled-unit selection.');
          const seed = { title: preset.name, description: preset.instructions, settingsText };
          const session = newSession(i, 'wheel-draft', structuredClone(seed));
          const message = await i.followUp({ content: 'Create a private event draft with these copied hosting settings. Review its date before publishing.',
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(wheelButton(`wheel:${session.id}:draft`, 'Create event draft'))],
            ...privateReply, allowedMentions: { parse: [] } });
          sessions.bind(session.id, message.id);
        }
        return;
      }
      if (!['presets', 'add', 'edit', 'remove'].includes(sub)) throw new CommandError('Choose a supported wheel action.');
      await i.deferReply(privateReply);
      await requireCommunityOfficer(i.guild, i.user.id, database);
      const presets = store.list(i.guildId);
      if (sub === 'add') {
        if (presets.length >= 50) throw new CommandError('A guild supports at most 50 presets. Remove a preset first.');
        await showEditor(i, { ...structuredClone(STARTER_PRESETS[0]), id: randomUUID(), guildId: i.guildId, name: 'New preset' }, false);
        return;
      }
      const id = i.options.getString('id');
      if (id) {
        const preset = presets.find(p => p.id === id);
        if (!preset) throw new CommandError('Preset unavailable in this server. Reopen /wheel action:presets.');
        await showEditor(i, preset, sub === 'remove');
        return;
      }
      const session = newSession(i, 'wheel-picker', { remove: sub === 'remove' } satisfies Picker);
      const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
      for (let offset = 0; offset < presets.length; offset += 25) {
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder()
          .setCustomId(`wheel:${session.id}:pick${offset / 25}`).setPlaceholder(`Choose preset ${offset + 1}–${Math.min(offset + 25, presets.length)}`)
          .addOptions(presets.slice(offset, offset + 25).map(p => ({ label: p.name, value: p.id, description: `${p.enabled ? 'Enabled' : 'Disabled'} · Revision ${p.revision}` })))));
      }
      const message = await i.editReply({ embeds: [new EmbedBuilder().setTitle('Wheel presets · Private')
        .setDescription(presets.length ? 'Choose a preset to preview and edit. Use /wheel action:add to create one.' : 'No presets remain. Use /wheel action:add to create a complete hosting package.')
        .addFields({ name: 'Supported disabled units', value: escapeMarkdown(SUPPORTED_UNITS.join(', ')) })], components, allowedMentions: { parse: [] } });
      sessions.bind(session.id, message.id);
    },
    async handleInteraction(i: Interaction): Promise<boolean> {
      if (!('customId' in i) || !i.customId.startsWith('wheel:')) return false;
      if (!(i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())) return false;
      if (!i.guild || !i.guildId || !i.channelId) throw new CommandError('Use /wheel in a server.');
      const [, id, action, extra] = i.customId.split(':');
      if (!id || !action || extra) throw new CommandError('Reopen /wheel action:presets.');
      const binding = { guildId: i.guildId, channelId: i.channelId, messageId: i.message?.id ?? null };
      const session = sessions.get(id, i.user.id, binding, now());
      if (session.kind === 'wheel-draft') {
        if (action !== 'draft' || !i.isButton()) throw new CommandError('Reopen /wheel action:spin.');
        // The shared draft opener refreshes officer membership immediately before writing.
        await (dependencies.createDraft ?? createEventDraft)(i, structuredClone(session.data as Partial<EventDraftInput>), () => {
          sessions.get(id, i.user.id, binding, now());
          // Consume synchronously before persistence so overlapping clicks cannot duplicate drafts.
          sessions.delete(id);
        });
        return true;
      }
      await requireCommunityOfficer(i.guild, i.user.id, database);
      // Authorization awaits the network; recheck session revocation/expiry afterward.
      sessions.get(id, i.user.id, binding, now());
      if (session.kind === 'wheel-picker') {
        if (!/^pick[01]$/.test(action) || !i.isStringSelectMenu()) throw new CommandError('Reopen /wheel action:presets.');
        const p = store.list(i.guildId).find(preset => preset.id === i.values[0]);
        if (!p) throw new CommandError('Preset changed or unavailable. Reopen /wheel action:presets.');
        session.kind = 'wheel-editor';
        session.data = { preset: p, expected: p.revision, remove: (session.data as Picker).remove } satisfies WheelEditor;
        await i.update(wheelPreview(session));
        return true;
      }
      if (session.kind !== 'wheel-editor' && session.kind !== 'wheel-form') throw new CommandError('Reopen /wheel action:presets.');
      const data = session.data as WheelEditor;
      if (data.expected > 0) current(data.preset);
      if (session.kind === 'wheel-form') {
        if (!/^apply-(basics|hosting|options)$/.test(action) || !i.isModalSubmit() || !i.isFromMessage()) throw new CommandError('Reopen /wheel action:presets.');
        const updated = validateWheelPreset(readWheelForm(data.preset, action.slice(6), key => i.fields.getTextInputValue(key)));
        const preview = newSession(i, 'wheel-editor', { ...data, preset: updated }, binding.messageId);
        sessions.delete(id);
        // Modal submits from a message update that same private preview.
        await i.update(wheelPreview(preview));
        return true;
      }
      if (!i.isButton()) throw new CommandError('Reopen /wheel action:presets.');
      if (data.remove) {
        if (action !== 'remove') throw new CommandError('Reopen /wheel action:remove.');
        store.remove(i.guildId, data.preset.id, data.expected);
        sessions.delete(id);
        await i.update({ content: 'Preset removed. Use /wheel action:presets for fresh controls.', embeds: [], components: [], allowedMentions: { parse: [] } });
        return true;
      }
      if (['basics', 'hosting', 'options'].includes(action)) {
        const editor = newSession(i, 'wheel-form', structuredClone(data), binding.messageId);
        await i.showModal(wheelModal(editor.id, action, data.preset));
      } else if (action === 'toggle') {
        data.preset.enabled = !data.preset.enabled;
        await i.update(wheelPreview(session));
      } else if (action === 'save') {
        store.save(data.preset, data.expected);
        sessions.delete(id);
        await i.update({ content: 'Preset saved. Use /wheel action:presets for fresh controls.', embeds: [], components: [], allowedMentions: { parse: [] } });
      } else throw new CommandError('Reopen /wheel action:presets.');
      return true;
    },
  };
}
export const wheelCommand = createWheelCommand();
