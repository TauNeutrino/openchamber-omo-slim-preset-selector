import { t } from './i18n.ts';
/**
 * Reading and rewriting of the oh-my-opencode-slim preset selection.
 *
 * Everything here is pure: the panel owns the host calls, this module owns the
 * rules. Writes mirror the OpenChamber server's omo-preset route, so a switch
 * made in the panel lands in the same layer and follows the same inheritance
 * rules as one made through the API. The file is edited in place with
 * jsonc-parser, which keeps comments, ordering and the original formatting of
 * every key except `preset`.
 */
import {
  applyEdits,
  modify,
  parse as parseJsonc,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from 'jsonc-parser';
import {
  mergeAgentOverrides,
  mergePresetMaps,
  normalizePreset,
  PresetResolutionError,
  resolvePresetDefinition,
  type AgentOverride,
} from './preset-merge.ts';

/** One entry of a model fallback chain, as the schema allows it. */
export type PresetModelRef = {
  model: string;
  variant?: string;
};

export type PresetAgent = {
  agent: string;
  /**
   * The configured models in order: a plain string model becomes a one-entry
   * chain, a `model` array a chain with the primary first. Empty when the block
   * configures no model at all.
   */
  models: PresetModelRef[];
  /** The agent-level `variant` key, which sits next to the whole model chain. */
  variant?: string;
  /** The agent takes its model from the session or the orchestrator instead. */
  inheritModelFrom?: 'session' | 'orchestrator';
  /** The value comes from the root `agents` map, which sits above the preset. */
  source?: 'root';
};

/** The model the agent actually runs on, or null when its block sets none. */
export const primaryModel = (agent: PresetAgent): string | null => agent.models[0]?.model ?? null;

/**
 * The variant the primary model runs with. The agent-level key wins over the
 * variant of the first chain entry, exactly like the plugin resolves it.
 */
export const primaryVariant = (agent: PresetAgent): string => (
  agent.variant ?? agent.models[0]?.variant ?? ''
);

export type ParsedPresetConfig = {
  /** The `preset` key, trimmed; null when the file does not set one. */
  preset: string | null;
  /** Agent lists of this layer's preset declarations; `extends` is not applied yet. */
  presets: Record<string, PresetAgent[]>;
  /** The raw `presets` object of this layer, merged over the other layer's. */
  presetsRaw: Record<string, unknown>;
  /** Root `agents` overrides of this layer; they sit above the active preset. */
  rootAgents: Record<string, AgentOverride>;
  /** All keys of the `presets` map, including blocks without a usable agent. */
  presetNames: string[];
  /** Whether the file carries a `presets` object at all; an empty map counts. */
  hasPresets: boolean;
  /** A file holding only comments or whitespace, which has no root object yet. */
  commentOnly: boolean;
};

export type ParseOutcome =
  | { ok: true; config: ParsedPresetConfig }
  | { ok: false; error: string };

export type PresetLayerKind = 'global' | 'project';

export type ParsedLayer = {
  kind: PresetLayerKind;
  /** The path shown to the user, e.g. `~/.config/opencode/oh-my-opencode-slim.json`. */
  path: string;
  raw: string;
  config: ParsedPresetConfig;
};

export type ActivePreset = {
  name: string;
  origin: PresetLayerKind;
};

/** Which layers define a preset name. */
export type PresetOrigin = 'global' | 'project' | 'both';

export type PresetView = {
  active: ActivePreset;
  /** The preset each layer selects on its own, before the override wins. */
  globalPreset: string | null;
  projectPreset: string | null;
  /** Each preset's own agents with `extends` resolved, without root overrides. */
  presets: Record<string, PresetAgent[]>;
  /** The same presets with the root `agents` overrides applied; what the plugin runs. */
  effective: Record<string, PresetAgent[]>;
  origins: Record<string, PresetOrigin>;
  /** Direct `extends` parent of each preset. */
  parents: Record<string, string | null>;
  /** Presets that cannot be resolved (cycle, missing parent), by preset name. */
  errors: Record<string, string>;
  agents: PresetAgent[];
  activePath: string;
  /** Names defined by each layer, for the scope selector. */
  globalNames: string[];
  projectNames: string[];
};

export type ResolveOutcome =
  | { ok: true; view: PresetView }
  | { ok: false; error: string };

export type PresetSwitchScope = 'global' | 'project';

export type SwitchPlan =
  | { ok: true; scope: PresetSwitchScope; path: string; names: string[] }
  | { ok: false; code: 'no-project' | 'unknown-preset' | 'not-in-global' | 'empty-preset' | 'broken-preset'; message: string };

const BOM = '\uFEFF';

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const nonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Reads one agent's `model` value. The schema allows a plain string or an
 * array of strings and `{ id, variant }` objects as a fallback chain.
 */
const modelRefsOf = (value: unknown): PresetModelRef[] => {
  if (typeof value === 'string') {
    const model = value.trim();
    return model ? [{ model }] : [];
  }
  if (!Array.isArray(value)) return [];
  const refs: PresetModelRef[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const model = entry.trim();
      if (model) refs.push({ model });
      continue;
    }
    if (!isPlainObject(entry)) continue;
    const model = nonEmptyString(entry.id);
    if (!model) continue;
    const variant = nonEmptyString(entry.variant);
    refs.push(variant ? { model, variant } : { model });
  }
  return refs;
};

/**
 * True when an override carries something worth a row: a model, an inheritance
 * source, or any other agent key (prompt, skills, permission, ...). A block
 * whose only content is an unusable model stays out.
 */
const hasMeaningfulOverride = (override: AgentOverride): boolean => (
  modelRefsOf(override.model).length > 0
  || override.inheritModelFrom !== undefined
  || Object.keys(override).some((key) => key !== 'model')
);

export const agentFromOverride = (
  agent: string,
  override: AgentOverride,
  source?: 'root',
): PresetAgent => {
  const result: PresetAgent = { agent, models: modelRefsOf(override.model) };
  const variant = nonEmptyString(override.variant);
  if (variant) result.variant = variant;
  const inherit = override.inheritModelFrom;
  if (inherit === 'session' || inherit === 'orchestrator') result.inheritModelFrom = inherit;
  if (source) result.source = source;
  return result;
};

const agentsOfOverrideMap = (
  map: Record<string, AgentOverride>,
  rootOverrides?: Record<string, AgentOverride>,
): PresetAgent[] => {
  const agents: PresetAgent[] = [];
  for (const [agent, override] of Object.entries(map)) {
    if (!isPlainObject(override) || !hasMeaningfulOverride(override)) continue;
    const fromRoot = rootOverrides !== undefined && Object.hasOwn(rootOverrides, agent);
    agents.push(agentFromOverride(agent, override, fromRoot ? 'root' : undefined));
  }
  return agents;
};

const agentsOf = (block: unknown): PresetAgent[] => agentsOfOverrideMap(normalizePreset(block).agents);

/**
 * Parses one preset file. A missing file is the caller's concern; anything
 * unreadable or malformed is refused here, because guessing an empty config
 * would let a write replace content that could not be understood.
 */
export const parseConfigText = (raw: string, label: string): ParseOutcome => {
  const emptyConfig = (): ParsedPresetConfig => ({
    preset: null,
    presets: {},
    presetsRaw: {},
    rootAgents: {},
    presetNames: [],
    hasPresets: false,
    commentOnly: true,
  });
  const content = raw.startsWith(BOM) ? raw.slice(1) : raw;
  if (!content.trim()) {
    return { ok: true, config: emptyConfig() };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(content, errors, { allowTrailingComma: true });
  const commentOnly = parsed === undefined
    && errors.every((entry) => printParseErrorCode(entry.error) === 'ValueExpected');
  if (commentOnly) {
    return { ok: true, config: emptyConfig() };
  }
  if (errors.length > 0) {
    const first = errors[0];
    const where = first && Number.isFinite(first.offset)
      ? ` (${printParseErrorCode(first.error)} at offset ${first.offset})`
      : '';
    return { ok: false, error: `${label} ${t('containsInvalidJsonc')}${where}.` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `${label} ${t('mustBeJsonObject')}` };
  }

  let preset: string | null = null;
  if (Object.prototype.hasOwnProperty.call(parsed, 'preset')) {
    preset = nonEmptyString(parsed.preset);
    if (preset === null) {
      return { ok: false, error: `In ${label} ist "preset" kein nicht-leerer String.` };
    }
  }

  let presets: Record<string, PresetAgent[]> = {};
  let presetsRaw: Record<string, unknown> = {};
  let presetNames: string[] = [];
  let hasPresets = false;
  if (Object.prototype.hasOwnProperty.call(parsed, 'presets')) {
    const value = parsed.presets;
    if (!isPlainObject(value)) {
      return { ok: false, error: `In ${label} ist "presets" kein Objekt.` };
    }
    hasPresets = true;
    presetsRaw = value;
    presetNames = Object.keys(value);
    presets = Object.fromEntries(
      presetNames.map((name) => [name, agentsOf(value[name])]),
    );
  }

  const rootAgents: Record<string, AgentOverride> = {};
  if (Object.prototype.hasOwnProperty.call(parsed, 'agents')) {
    const value = parsed.agents;
    if (!isPlainObject(value)) {
      return { ok: false, error: `In ${label} ist "agents" kein Objekt.` };
    }
    for (const [agent, entry] of Object.entries(value)) {
      if (isPlainObject(entry)) rootAgents[agent] = entry as AgentOverride;
    }
  }

  return {
    ok: true,
    config: { preset, presets, presetsRaw, rootAgents, presetNames, hasPresets, commentOnly: false },
  };
};

/**
 * Uses the indentation the file already uses, so an inserted `preset` key sits
 * like its neighbours. Existing lines are never reformatted.
 */
const formattingFor = (content: string): FormattingOptions => {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)\S/m.exec(content)?.[1];
  if (indent?.startsWith('\t')) {
    return { insertSpaces: false, tabSize: 1, eol };
  }
  if (indent) {
    return { insertSpaces: true, tabSize: Math.min(Math.max(indent.length, 1), 8), eol };
  }
  return { insertSpaces: true, tabSize: 2, eol };
};

/**
 * Returns the file with only `preset` set. Throws instead of returning a
 * doubtful result: the caller must not write then.
 */
export const applyPresetToText = (raw: string, name: string): string => {
  const nextName = name.trim();
  if (!nextName) {
    throw new Error(t('presetNameEmpty'));
  }

  const before = parseConfigText(raw, t('configLabel'));
  if (!before.ok) {
    throw new Error(before.error);
  }

  const hasBom = raw.startsWith(BOM);
  const content = hasBom ? raw.slice(1) : raw;
  const { eol } = formattingFor(content);

  let next: string;
  if (before.config.commentOnly) {
    // jsonc-parser appends an object below a comment-only file, which turns a
    // leading comment into a trailing one. Keep the comments and put the new
    // root object after them.
    const prefix = content.trimEnd();
    next = `${prefix ? `${prefix}${eol}` : ''}${JSON.stringify({ preset: nextName }, null, 2)}${eol}`;
  } else {
    const edits = modify(content, ['preset'], nextName, { formattingOptions: formattingFor(content) });
    next = applyEdits(content, edits);
  }

  const after = parseConfigText(next, t('resultLabel'));
  if (!after.ok) {
    throw new Error(`Die Änderung würde die Konfiguration beschädigen: ${after.error}`);
  }
  if (after.config.preset !== nextName) {
    throw new Error(t('changeNotVerified'));
  }
  if (JSON.stringify(after.config.presets) !== JSON.stringify(before.config.presets)) {
    throw new Error(t('presetsMapChanged'));
  }

  return hasBom ? `${BOM}${next}` : next;
};

/**
 * Builds the cross-layer picture the panel shows: which preset each layer
 * selects, which names exist (merged per preset and agent, like the plugin),
 * each preset's resolved agents with `extends`, and the root `agents` overlay
 * that sits above the active preset. A preset that cannot be resolved (cycle,
 * missing parent) keeps an empty list and an entry in `errors` — it must never
 * make the whole panel unreadable.
 */
export const resolvePresetView = (
  global: ParsedLayer,
  project: ParsedLayer | null,
): ResolveOutcome => {
  const merged = mergePresetMaps(global.config.presetsRaw, project?.config.presetsRaw ?? null);
  const names = Object.keys(merged);
  const globalNames = Object.keys(global.config.presetsRaw);
  const projectNames = project ? Object.keys(project.config.presetsRaw) : [];
  const projectPreset = project?.config.preset ?? null;
  const globalPreset = global.config.preset;
  const activeName = projectPreset ?? globalPreset;

  if (!activeName) {
    return { ok: false, error: `In ${global.path} ist kein Preset gesetzt.` };
  }
  if (!Object.hasOwn(merged, activeName)) {
    const where = projectPreset ? (project?.path ?? global.path) : global.path;
    return { ok: false, error: `Preset "${activeName}" ist in ${where} nicht definiert.` };
  }

  const origins: Record<string, PresetOrigin> = {};
  for (const name of names) {
    const inGlobal = globalNames.includes(name);
    const inProject = projectNames.includes(name);
    origins[name] = inGlobal && inProject ? 'both' : inProject ? 'project' : 'global';
  }

  // Root `agents` merge over each other and then over the resolved preset;
  // agents that appear there are tagged so the row can say where it came from.
  const rootOverrides = mergeAgentOverrides(global.config.rootAgents, project?.config.rootAgents ?? {});

  const presets: Record<string, PresetAgent[]> = {};
  const effective: Record<string, PresetAgent[]> = {};
  const parents: Record<string, string | null> = {};
  const errors: Record<string, string> = {};
  for (const name of names) {
    try {
      const definition = resolvePresetDefinition(name, merged);
      parents[name] = definition.extends ?? null;
      presets[name] = agentsOfOverrideMap(definition.agents);
      effective[name] = agentsOfOverrideMap(
        mergeAgentOverrides(definition.agents, rootOverrides),
        rootOverrides,
      );
    } catch (error) {
      presets[name] = [];
      effective[name] = [];
      parents[name] = null;
      errors[name] = error instanceof PresetResolutionError || error instanceof Error
        ? error.message
        : String(error);
    }
  }

  return {
    ok: true,
    view: {
      active: { name: activeName, origin: projectPreset ? 'project' : 'global' },
      globalPreset,
      projectPreset,
      presets,
      effective,
      origins,
      parents,
      errors,
      agents: effective[activeName] ?? [],
      activePath: projectPreset ? (project?.path ?? global.path) : global.path,
      globalNames,
      projectNames,
    },
  };
};

/**
 * Plans a preset switch for an explicit scope. The project layer may reference
 * any merged preset name (it inherits the global map); the global layer can only
 * select presets it defines itself. Mirrors the plugin's refusal to select an
 * empty preset or one whose inheritance cannot be resolved.
 */
export const planPresetSwitch = (args: {
  scope: PresetSwitchScope;
  name: string;
  /** Target path for the project layer; null when no project is open. */
  projectPath: string | null;
  global: ParsedLayer;
  project: ParsedLayer | null;
}): SwitchPlan => {
  const { scope, name, projectPath, global, project } = args;
  if (scope === 'project' && !projectPath) {
    return { ok: false, code: 'no-project', message: t('noProjectOpen') };
  }

  const merged = mergePresetMaps(global.config.presetsRaw, project?.config.presetsRaw ?? null);
  const globalNames = Object.keys(global.config.presetsRaw);
  const names = scope === 'global' ? globalNames : Object.keys(merged);

  if (scope === 'global' && !globalNames.includes(name)) {
    const projectOnly = project ? Object.keys(project.config.presetsRaw).includes(name) : false;
    return {
      ok: false,
      code: 'not-in-global',
      message: projectOnly
        ? `Preset "${name}" ist nur im Projekt definiert; global wäre es nicht sichtbar.`
        : `Preset "${name}" ist in ${global.path} nicht definiert.`,
    };
  }
  if (!names.includes(name)) {
    const where = projectPath ?? global.path;
    return {
      ok: false,
      code: 'unknown-preset',
      message: `Preset "${name}" ist in ${where} nicht definiert.`,
    };
  }

  let definition;
  try {
    definition = resolvePresetDefinition(name, merged);
  } catch (error) {
    return {
      ok: false,
      code: 'broken-preset',
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (Object.keys(definition.agents).length === 0 && definition.marketplace === undefined) {
    return {
      ok: false,
      code: 'empty-preset',
      message: `Preset "${name}" ist leer (keine Agent-Overrides).`,
    };
  }

  return {
    ok: true,
    scope,
    path: scope === 'project' ? (projectPath as string) : global.path,
    names,
  };
};

/** The agent that every preset configures, used as the dropdown's one-line hint. */
export const orchestratorModel = (
  presets: Record<string, PresetAgent[]>,
  name: string,
): string | null => {
  const agents = presets[name] ?? [];
  const orchestrator = agents.find((agent) => agent.agent === 'orchestrator');
  const chosen = (orchestrator && primaryModel(orchestrator) ? orchestrator : undefined)
    ?? agents.find((agent) => primaryModel(agent) !== null);
  return chosen ? primaryModel(chosen) : null;
};

export const sortedPresetNames = (presets: Record<string, PresetAgent[]>): string[] => (
  Object.keys(presets).sort((left, right) => left.localeCompare(right))
);

export const clearPresetFromText = (raw: string): string => {
  const before = parseConfigText(raw, t('configLabel'));
  if (!before.ok) throw new Error(before.error);
  if (before.config.commentOnly) return raw;
  const hasBom = raw.startsWith(BOM);
  const content = hasBom ? raw.slice(1) : raw;
  const fmt = formattingFor(content);
  const edits = modify(content, ['preset'], undefined, { formattingOptions: fmt });
  const next = applyEdits(content, edits);
  const after = parseConfigText(next, t('resultLabel'));
  if (!after.ok) throw new Error(`Die Änderung würde die Konfiguration beschädigen: ${after.error}`);
  if (after.config.preset !== null) throw new Error(t('changeNotVerified'));
  return hasBom ? `${BOM}${next}` : next;
};

/**
 * Adds a preset below `presets`. With `extendsName` the new block keeps the
 * structured form (`{ extends, agents }`) so the inheritance survives; without
 * it the flat agent map stays, as before.
 */
export const addPresetToText = (
  raw: string, name: string, agents: PresetAgent[], extendsName: string | null = null,
): string => {
  const nextName = name.trim();
  if (!nextName) throw new Error(t('presetNameEmpty'));
  const before = parseConfigText(raw, t('configLabel'));
  if (!before.ok) throw new Error(before.error);
  if (before.config.presetNames.includes(nextName)) throw new Error(t('presetAlreadyExists', nextName));

  const hasBom = raw.startsWith(BOM);
  const content = hasBom ? raw.slice(1) : raw;
  const fmt = formattingFor(content);

  const agentObj: Record<string, Record<string, unknown>> = {};
  for (const a of agents) {
    const block: Record<string, unknown> = {};
    if (a.models.length > 0) {
      // Keep a chain a chain; a single plain model stays a string like in the
      // source preset.
      block.model = a.models.length === 1 && !a.models[0].variant
        ? a.models[0].model
        : a.models.map((ref) => (ref.variant ? { id: ref.model, variant: ref.variant } : ref.model));
    }
    if (a.variant) block.variant = a.variant;
    if (a.inheritModelFrom) block.inheritModelFrom = a.inheritModelFrom;
    agentObj[a.agent] = block;
  }
  const presetBody: unknown = extendsName ? { extends: extendsName, agents: agentObj } : agentObj;

  let next: string;
  if (before.config.commentOnly || !before.config.hasPresets) {
    const prefix = content.trimEnd();
    const body = JSON.stringify({ presets: { [nextName]: presetBody } }, null, fmt.tabSize || 2);
    next = `${prefix ? `${prefix}${fmt.eol}` : ''}${body}${fmt.eol}`;
  } else {
    const edits = modify(content, ['presets', nextName], presetBody, { formattingOptions: fmt });
    next = applyEdits(content, edits);
  }

  const after = parseConfigText(next, t('resultLabel'));
  if (!after.ok) throw new Error(`Die Änderung würde die Konfiguration beschädigen: ${after.error}`);
  if (!after.config.presetNames.includes(nextName)) throw new Error(t('changeNotVerified'));
  return hasBom ? `${BOM}${next}` : next;
};

export const applyAgentModelToText = (
  raw: string, presetName: string, agentName: string, model: string, variant?: string | null,
): string => {
  const nextModel = model.trim();
  if (!nextModel) throw new Error(t('presetNameEmpty'));
  const before = parseConfigText(raw, t('configLabel'));
  if (!before.ok) throw new Error(before.error);
  if (before.config.commentOnly) throw new Error(t('changeNotVerified'));

  const hasBom = raw.startsWith(BOM);
  const content = hasBom ? raw.slice(1) : raw;
  const parsed = parseJsonc(content, [], { allowTrailingComma: true });
  if (!isPlainObject(parsed)) throw new Error(t('mustBeJsonObject'));
  const presets = isPlainObject(parsed.presets) ? parsed.presets : null;
  if (!presets || !isPlainObject(presets[presetName])) throw new Error(t('presetNotDefined', presetName, t('configLabel')));
  const block = presets[presetName] as Record<string, unknown>;
  const wrapped = isPlainObject(block.agents);
  const basePath = wrapped
    ? ['presets', presetName, 'agents', agentName]
    : ['presets', presetName, agentName];
  const agentBlock = wrapped
    ? (isPlainObject(block.agents) ? (block.agents as Record<string, unknown>)[agentName] : null)
    : (block as Record<string, unknown>)[agentName];
  const currentModel = isPlainObject(agentBlock) ? agentBlock.model : undefined;

  const fmt = formattingFor(content);
  const v = variant?.trim() ?? '';
  let next = content;
  if (Array.isArray(currentModel)) {
    // A fallback chain: the picked model becomes the primary and the rest of
    // the chain survives as fallbacks. The variant belongs to the entry, not
    // to the agent, so the agent-level key stays untouched.
    const entry = v ? { id: nextModel, variant: v } : nextModel;
    const rest = currentModel.filter((item) => {
      const id = typeof item === 'string' ? item.trim() : (isPlainObject(item) ? nonEmptyString(item.id) : null);
      return id !== nextModel;
    });
    const modelEdits = modify(next, [...basePath, 'model'], [entry, ...rest], { formattingOptions: fmt });
    next = applyEdits(next, modelEdits);
  } else {
    const modelEdits = modify(next, [...basePath, 'model'], nextModel, { formattingOptions: fmt });
    next = applyEdits(next, modelEdits);
    const hasVariant = isPlainObject(agentBlock) && Object.prototype.hasOwnProperty.call(agentBlock, 'variant');
    if (v) {
      const variantEdits = modify(next, [...basePath, 'variant'], v, { formattingOptions: fmt });
      next = applyEdits(next, variantEdits);
    } else if (hasVariant) {
      const variantEdits = modify(next, [...basePath, 'variant'], undefined, { formattingOptions: fmt });
      next = applyEdits(next, variantEdits);
    }
  }
  const after = parseConfigText(next, t('resultLabel'));
  if (!after.ok) throw new Error(`Die Änderung würde die Konfiguration beschädigen: ${after.error}`);
  const agents = after.config.presets[presetName] ?? [];
  const changed = agents.find((a) => a.agent === agentName);
  if (!changed || primaryModel(changed) !== nextModel) throw new Error(t('changeNotVerified'));
  return hasBom ? `${BOM}${next}` : next;
};
