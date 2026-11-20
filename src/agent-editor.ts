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
  const chain = agent.models.map((ref) => (ref.variant ? { ...ref } : { model: ref.model }));
  // The agent-level `variant` key has no field of its own; it wins over the
  // variant of the primary entry at runtime (see primaryVariant). Mirror it
  // into that entry so the chain shows the value that actually runs and that a
  // save would write, instead of an empty box next to a variant pill.
  const agentVariant = agent.variant?.trim();
  if (chain.length > 0 && agentVariant) chain[0] = { ...chain[0], variant: agentVariant };
  return {
    chain,
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

  // The primary chain entry is the only place the variant is editable, and the
  // agent-level key outranks it. Keep the two in step: a value taken over from
  // the fallback must not be dropped (that would delete the only visible
  // variant), and clearing the entry must clear the key together with it.
  const primaryVariant = (draft.chain[0]?.variant ?? '').trim();
  const variant = draft.present.includes('variant')
    ? (draft.chain.length > 0 ? (primaryVariant || null) : (draft.variant.trim() || null))
    : (draft.variant.trim() || null);

  return {
    ok: true,
    patch: {
      models: draft.chain
        .map((ref) => (ref.variant ? { model: ref.model.trim(), variant: ref.variant.trim() } : { model: ref.model.trim() }))
        .filter((ref) => ref.model.length > 0),
      variant,
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

/** Variant names accepted by the wizard: lowercase, 1–24 chars, `.`/`-`/`_`. */
const VARIANT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,23}$/;

export const normalizeVariantName = (raw: string): string | null => {
  const value = raw.trim().toLowerCase();
  return value !== '' && VARIANT_NAME_RE.test(value) ? value : null;
};

export const isValidVariantName = (raw: string): boolean => normalizeVariantName(raw) !== null;

/** True when the model already sits in the chain somewhere other than `exceptIndex`. */
export const chainContainsModel = (
  chain: readonly PresetModelRef[],
  model: string,
  exceptIndex = -1,
): boolean => chain.some((ref, index) => index !== exceptIndex && ref.model === model);

/** Wizard state, shared by the panel and its tests. */
export type EditorWizard = {
  mode: 'replace' | 'add-fallback';
  index: number;
  step: 'model' | 'variant' | 'review';
  model: string | null;
  variantKind: 'none' | 'pick' | 'custom';
  variant: string | null;
  customText: string;
  origModel: string | null;
  origVariant: string | null;
  /** Opened from the chain's variant control: the model may not be changed. */
  lockedModel: boolean;
};

/** The chain entry the current wizard state describes. */
export const wizardEntryOf = (wizard: EditorWizard): PresetModelRef | null => {
  if (!wizard.model) return null;
  if (wizard.variantKind === 'custom') {
    const custom = normalizeVariantName(wizard.customText);
    return custom ? { model: wizard.model, variant: custom } : null;
  }
  const variant = wizard.variantKind === 'pick' ? (wizard.variant ?? '').trim() : '';
  return variant ? { model: wizard.model, variant } : { model: wizard.model };
};

/** A clicked model always advances to the variant step — there is no "next". */
export const wizardChooseModel = (wizard: EditorWizard, model: string): EditorWizard => {
  const same = wizard.mode === 'replace' && wizard.origModel === model && !!wizard.origVariant;
  return {
    ...wizard,
    step: 'variant',
    model,
    variantKind: same ? 'pick' : 'none',
    variant: same ? wizard.origVariant : null,
    customText: '',
  };
};

/** Picking "none" or a pill confirms it and advances to the review step. */
export const wizardChooseVariant = (
  wizard: EditorWizard,
  kind: 'none' | 'pick',
  variant: string | null,
): EditorWizard => ({
  ...wizard,
  step: 'review',
  variantKind: kind,
  variant: kind === 'pick' ? variant : null,
  customText: '',
});

/** A valid custom value advances to review; an invalid one keeps the step. */
export const wizardCommitCustom = (wizard: EditorWizard, raw: string): EditorWizard | null => {
  const normalized = normalizeVariantName(raw);
  if (!normalized) return null;
  return {
    ...wizard,
    step: 'review',
    variantKind: 'custom',
    variant: normalized,
    customText: normalized,
  };
};

/** True when applying the wizard would leave the replaced slot exactly as it is. */
export const wizardIsUnchanged = (wizard: EditorWizard, chain: readonly PresetModelRef[]): boolean => {
  if (wizard.mode !== 'replace') return false;
  const entry = wizardEntryOf(wizard);
  const current = chain[wizard.index];
  return !!entry && !!current
    && current.model === entry.model
    && (current.variant ?? '') === (entry.variant ?? '');
};

/** Applies the wizard to the chain; null when incomplete or a duplicate. */
export const wizardApply = (
  wizard: EditorWizard,
  chain: readonly PresetModelRef[],
): { chain: PresetModelRef[]; index: number } | null => {
  const entry = wizardEntryOf(wizard);
  if (!entry) return null;
  if (wizard.mode === 'replace') {
    if (wizard.index < 0 || wizard.index >= chain.length) return null;
    const next = [...chain];
    next[wizard.index] = entry;
    return { chain: next, index: wizard.index };
  }
  // A chain with the same model twice is pointless; keep the first entry.
  if (chainContainsModel(chain, entry.model)) return null;
  return { chain: [...chain, entry], index: chain.length };
};
