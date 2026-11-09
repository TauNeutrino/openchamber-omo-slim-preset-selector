/**
 * Pure state and patch building for the per-agent editor.
 *
 * The editor keeps plain text fields (they are what the user types); this module
 * turns them into the `AgentPatch` the config writer applies, and keeps the one
 * distinction the UI cannot show: an absent key versus an explicitly empty list
 * (`"skills": []` disables inheritance, an absent `skills` key keeps it).
 */
import type { AgentPatch, PresetAgent, PresetModelRef } from './config.ts';

export type PermissionMode = '' | 'allow' | 'ask' | 'deny' | 'json';

export type AgentEditorDraft = {
  /** Fallback chain, primary first. */
  chain: PresetModelRef[];
  variant: string;
  inherit: '' | 'session' | 'orchestrator';
  temperature: string;
  skills: string;
  skillsAdd: string;
  skillsRemove: string;
  skillsLocal: boolean;
  mcps: string;
  permissionMode: PermissionMode;
  permissionJson: string;
  displayName: string;
  color: string;
  /** Keys the agent carried when the editor opened. */
  present: string[];
};

export type DraftPatch =
  | { ok: true; patch: AgentPatch }
  | { ok: false; error: 'temperature' | 'permission' };

const PRESENT_KEYS = [
  'variant',
  'inheritModelFrom',
  'temperature',
  'skills',
  'skillsAdd',
  'skillsRemove',
  'skillsLocal',
  'mcps',
  'permission',
  'displayName',
  'color',
] as const;

export const draftFromAgent = (agent: PresetAgent): AgentEditorDraft => {
  const present: string[] = [];
  const record = agent as unknown as Record<string, unknown>;
  for (const key of PRESENT_KEYS) {
    if (record[key] !== undefined) present.push(key);
  }
  const permission = agent.permission;
  const mode: PermissionMode = permission === undefined
    ? ''
    : permission === 'allow' || permission === 'ask' || permission === 'deny'
      ? permission
      : 'json';
  return {
    chain: agent.models.map((ref) => (ref.variant ? { ...ref } : { model: ref.model })),
    variant: agent.variant ?? '',
    inherit: agent.inheritModelFrom ?? '',
    temperature: typeof agent.temperature === 'number' ? String(agent.temperature) : '',
    skills: (agent.skills ?? []).join(', '),
    skillsAdd: (agent.skillsAdd ?? []).join(', '),
    skillsRemove: (agent.skillsRemove ?? []).join(', '),
    skillsLocal: agent.skillsLocal === true,
    mcps: (agent.mcps ?? []).join(', '),
    permissionMode: mode,
    permissionJson: mode === 'json' ? JSON.stringify(permission, null, 2) : '',
    displayName: agent.displayName ?? '',
    color: agent.color ?? '',
    present,
  };
};

const splitList = (value: string): string[] => (
  value.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0)
);

/**
 * Blank list text means "remove the key" — unless the agent already had that
 * list, in which case it means an explicit empty list, which is a real
 * configuration (no inherited skills).
 */
const listPatch = (
  draft: AgentEditorDraft,
  key: 'skills' | 'skillsAdd' | 'skillsRemove' | 'mcps',
  text: string,
): string[] | null => {
  const items = splitList(text);
  if (items.length > 0) return items;
  return draft.present.includes(key) ? [] : null;
};

export const patchFromDraft = (draft: AgentEditorDraft): DraftPatch => {
  let permission: unknown;
  if (draft.permissionMode === '') {
    permission = null;
  } else if (draft.permissionMode === 'json') {
    try {
      permission = JSON.parse(draft.permissionJson);
    } catch {
      return { ok: false, error: 'permission' };
    }
  } else {
    permission = draft.permissionMode;
  }

  const temperatureText = draft.temperature.trim();
  let temperature: number | null = null;
  if (temperatureText !== '') {
    const value = Number(temperatureText);
    if (!Number.isFinite(value) || value < 0 || value > 2) {
      return { ok: false, error: 'temperature' };
    }
    temperature = value;
  }

  return {
    ok: true,
    patch: {
      models: draft.chain
        .map((ref) => (ref.variant ? { model: ref.model.trim(), variant: ref.variant.trim() } : { model: ref.model.trim() }))
        .filter((ref) => ref.model.length > 0),
      variant: draft.variant.trim() ? draft.variant.trim() : null,
      inheritModelFrom: draft.inherit === '' ? null : draft.inherit,
      temperature,
      skills: listPatch(draft, 'skills', draft.skills),
      skills_add: listPatch(draft, 'skillsAdd', draft.skillsAdd),
      skills_remove: listPatch(draft, 'skillsRemove', draft.skillsRemove),
      skills_include_local: draft.skillsLocal
        ? true
        : draft.present.includes('skillsLocal') ? false : null,
      mcps: listPatch(draft, 'mcps', draft.mcps),
      permission,
      displayName: draft.displayName.trim() ? draft.displayName.trim() : null,
      color: draft.color.trim() ? draft.color.trim() : null,
    },
  };
};

/** Chain helpers the editor's list controls use. */
export const moveInChain = (chain: readonly PresetModelRef[], from: number, to: number): PresetModelRef[] => {
  if (from === to || from < 0 || to < 0 || from >= chain.length || to >= chain.length) return [...chain];
  const next = [...chain];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
};

export const removeFromChain = (chain: readonly PresetModelRef[], index: number): PresetModelRef[] => (
  chain.filter((_, position) => position !== index)
);

export const setChainVariant = (
  chain: readonly PresetModelRef[],
  index: number,
  variant: string,
): PresetModelRef[] => chain.map((ref, position) => {
  if (position !== index) return ref;
  const trimmed = variant.trim();
  return trimmed ? { model: ref.model, variant: trimmed } : { model: ref.model };
});
