import { CommandError } from '../commandError.js';

export interface WheelPreset {
  id: string;
  guildId: string;
  name: string;
  maps: string[];
  mode: 'Team' | 'Free For All';
  teams: number | 'Duos' | 'Trios' | 'Quads' | 'Humans Vs Nations' | null;
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Impossible';
  bots: number;
  nations: number | 'default' | 'disabled';
  mapSize: 'Normal' | 'Compact';
  disabledUnits: string[];
  donateGold: boolean;
  donateTroops: boolean;
  randomSpawn: boolean;
  infiniteGold: boolean;
  infiniteTroops: boolean;
  instantBuild: boolean;
  instructions: string;
  enabled: boolean;
  revision: number;
}

// Deliberately small catalog; settings match the checked local engine-api source.
export const SUPPORTED_MAPS = ['World', 'Europe', 'Black Sea', 'Caribbean'] as const;
export const SUPPORTED_UNITS = ['Transport', 'Warship', 'Shell', 'SAMMissile', 'Port',
  'Atom Bomb', 'Hydrogen Bomb', 'Trade Ship', 'Missile Silo', 'Defense Post',
  'SAM Launcher', 'City', 'MIRV', 'MIRV Warhead', 'Train', 'Factory'] as const;
const starter = (id: string, name: string, maps: string[], changes: Partial<WheelPreset> = {}): WheelPreset => ({
  id, guildId: 'starter', name, maps, mode: 'Team', teams: 2, difficulty: 'Medium', bots: 100,
  nations: 'default', mapSize: 'Normal', disabledUnits: [], donateGold: true, donateTroops: true,
  randomSpawn: false, infiniteGold: false, infiniteTroops: false, instantBuild: false,
  instructions: 'A human host applies these suggested settings in OpenFront.', enabled: true, revision: 0,
  ...changes,
});
export const STARTER_PRESETS: WheelPreset[] = [
  starter('classic', 'Classic clan teams', ['World', 'Europe']),
  starter('squad', 'Squad skirmish', ['Europe', 'Black Sea'], { teams: 'Quads', bots: 50, nations: 'disabled' }),
  starter('naval', 'Naval night', ['Black Sea', 'Caribbean'], { instructions: 'Emphasize naval play. Ports and warships stay enabled; a human host applies these suggested settings.' }),
  starter('conventional', 'Conventional warfare', ['World', 'Europe'], { disabledUnits: ['Atom Bomb', 'Hydrogen Bomb', 'MIRV', 'MIRV Warhead'] }),
  starter('ffa', 'Friendly free-for-all', ['Europe', 'World'], { mode: 'Free For All', teams: null }),
  starter('humans', 'Humans versus nations', ['World', 'Europe'], { teams: 'Humans Vs Nations', difficulty: 'Hard', bots: 0 }),
];

export function validateWheelPreset(input: WheelPreset): WheelPreset {
  const fail = (message: string): never => { throw new CommandError(message); };
  if (!input || typeof input !== 'object') fail('Supply a complete preset.');
  for (const field of ['id', 'guildId', 'name'] as const) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > (field === 'name' ? 80 : 100)) {
      fail(`Preset ${field} must contain 1–${field === 'name' ? 80 : 100} characters.`);
    }
  }
  if (!Array.isArray(input.maps) || input.maps.length < 1 || input.maps.length > 10 ||
      new Set(input.maps).size !== input.maps.length || input.maps.some(map => !(SUPPORTED_MAPS as readonly string[]).includes(map))) {
    fail(`Choose 1–10 distinct supported maps: ${SUPPORTED_MAPS.join(', ')}.`);
  }
  if (!['Team', 'Free For All'].includes(input.mode)) fail('Choose Team or Free For All mode.');
  const validTeams = Number.isInteger(input.teams) && Number(input.teams) >= 2 && Number(input.teams) <= 400 ||
    ['Duos', 'Trios', 'Quads', 'Humans Vs Nations'].includes(String(input.teams));
  if (input.mode === 'Free For All' ? input.teams !== null : !validTeams) {
    fail('Free For All requires no teams; Team requires 2–400 teams, Duos, Trios, Quads, or Humans Vs Nations.');
  }
  if (!['Easy', 'Medium', 'Hard', 'Impossible'].includes(input.difficulty)) fail('Choose Easy, Medium, Hard, or Impossible difficulty.');
  if (!Number.isInteger(input.bots) || input.bots < 0 || input.bots > 400) fail('Bots must be a whole number from 0 to 400.');
  if (input.nations !== 'default' && input.nations !== 'disabled' &&
      (!Number.isInteger(input.nations) || Number(input.nations) < 1 || Number(input.nations) > 400)) {
    fail('Nations must be default, disabled, or a whole number from 1 to 400.');
  }
  if (input.teams === 'Humans Vs Nations' && input.nations === 'disabled') fail('Humans Vs Nations requires nations enabled.');
  if (!['Normal', 'Compact'].includes(input.mapSize)) fail('Choose Normal or Compact map size.');
  if (!Array.isArray(input.disabledUnits) || new Set(input.disabledUnits).size !== input.disabledUnits.length ||
      input.disabledUnits.some(unit => !(SUPPORTED_UNITS as readonly string[]).includes(unit))) {
    fail(`Choose distinct disabled units from: ${SUPPORTED_UNITS.join(', ')}.`);
  }
  for (const field of ['enabled', 'donateGold', 'donateTroops', 'randomSpawn', 'infiniteGold', 'infiniteTroops', 'instantBuild'] as const) {
    if (typeof input[field] !== 'boolean') fail(`${field} must be yes or no.`);
  }
  if (typeof input.instructions !== 'string' || input.instructions.length > 1000) fail('Hosting instructions may contain at most 1000 characters.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail('Invalid preset revision. Reopen the menu.');
  return structuredClone(input);
}
