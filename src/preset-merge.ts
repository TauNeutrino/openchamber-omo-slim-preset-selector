/**
 * Preset merge and inheritance semantics for oh-my-opencode-slim.
 *
 * This is a dependency-free port of the reference implementation in
 * `oh-my-opencode-slim/dist/chunks/index-01tcrt5t.js` (`src/config/presets.ts`).
 * Every function is total: malformed input is skipped instead of thrown on, and
 * own-property access plus `Object.defineProperty` keep prototype-sensitive
 * keys (`__proto__`, `constructor`) from leaking into prototypes.
 */

/** One model in a fallback chain, or a plain `provider/model` string. */
export type AgentModelRef = string | { id: string; variant?: string };

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = PermissionAction | Record<string, PermissionAction>;
type PermissionConfig = PermissionAction | Record<string, PermissionRule>;

/** Every per-agent key the reference schema accepts. */
export type AgentOverride = {
  model?: AgentModelRef | AgentModelRef[];
  inheritModelFrom?: 'session' | 'orchestrator';
  variant?: string;
  temperature?: number;
  skills?: string[];
  skills_add?: string[];
  skills_remove?: string[];
  skills_include_local?: boolean;
  mcps?: string[];
  prompt?: string;
  orchestratorPrompt?: string;
  displayName?: string;
  color?: string;
  description?: string;
  primary?: boolean;
  subagents?: string[];
  permission?: PermissionConfig;
  options?: Record<string, unknown>;
};

export type MarketplaceActivation = {
  agents?: string[];
  agents_add?: string[];
  agents_remove?: string[];
};

export type NormalizedPreset = {
  extends?: string;
  agents: Record<string, AgentOverride>;
  marketplace?: MarketplaceActivation;
};

/** Legacy preset agent names that fold onto a canonical agent name. */
export const AGENT_ALIASES: Record<string, string> = {
  explore: 'explorer',
  librarian: 'explorer',
  'frontend-ui-ux-engineer': 'designer',
};

const STRICTNESS: Record<string, number> = { allow: 0, ask: 1, deny: 2 };
const ACTION_BY_STRICTNESS = ['allow', 'ask', 'deny'] as const;
const MARKETPLACE_ACTIVATION_KEYS = ['agents', 'agents_add', 'agents_remove'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Own-property read; never walks the prototype chain. */
const ownValue = (record: Record<string, unknown>, name: string): unknown => {
  if (!Object.hasOwn(record, name)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

/** Assign an own data property, so `__proto__` cannot rewrite a prototype. */
const defineOwn = <T>(target: Record<string, T>, key: string, value: T): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
};

const aliasOf = (name: string): string | undefined => (
  Object.hasOwn(AGENT_ALIASES, name) ? AGENT_ALIASES[name] : undefined
);

const stringList = (value: unknown): string[] | undefined => (
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : undefined
);

const agentMap = (value: unknown): Record<string, AgentOverride> => {
  const result: Record<string, AgentOverride> = {};
  if (!isRecord(value)) return result;
  for (const [name, entry] of Object.entries(value)) {
    if (isRecord(entry)) defineOwn(result, name, entry as AgentOverride);
  }
  return result;
};

/**
 * Every key of a JSON object as own data properties. `Object.entries` skips
 * nothing relevant, but it loses the distinction an object literal made for
 * `__proto__`: the parser's own-name list is the only way to see that key.
 */
const ownNamesOf = (value: Record<string, unknown>): string[] => [
  ...Object.keys(value),
  ...Object.getOwnPropertyNames(value).filter((name) => !(name in value)),
];

// Prototype-sensitive agent names are not valid identifiers for an override map:
// they would resolve through Object.prototype instead of own entries.
const isUsableAgentName = (name: string): boolean => (
  name !== '__proto__' && name !== 'constructor' && name !== 'prototype'
);

const isPresetAgentMap = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  return Object.keys(value).every((name) => isRecord(ownValue(value, name)));
};

/**
 * Structured syntax is `{ extends?, agents: {...}, marketplace? }`; the inline
 * form keeps agent keys at the top level and may still carry `extends`.
 */
const usesStructuredPresetSyntax = (input: unknown): boolean => {
  if (!isRecord(input)) return false;
  const agents = ownValue(input, 'agents');
  return isRecord(agents) && isPresetAgentMap(agents);
};

/** An agent override map must only carry usable agent names. */
const mergeAgentOverrideMaps = (
  base: Record<string, AgentOverride> | undefined,
  override: Record<string, AgentOverride> | undefined,
): Record<string, AgentOverride> => {
  const result: Record<string, AgentOverride> = {};
  for (const [name, entry] of Object.entries(base ?? {})) {
    if (isUsableAgentName(name) && isRecord(entry)) defineOwn(result, name, entry);
  }
  for (const [name, entry] of Object.entries(override ?? {})) {
    if (isUsableAgentName(name) && isRecord(entry)) defineOwn(result, name, entry);
  }
  return result;
};

const isMarketplaceActivation = (value: unknown): boolean => (
  isRecord(value) && MARKETPLACE_ACTIVATION_KEYS.some((key) => Object.hasOwn(value, key))
);

const normalizeMarketplace = (value: unknown): MarketplaceActivation | undefined => {
  if (!isRecord(value)) return undefined;
  const result: MarketplaceActivation = {};
  for (const key of MARKETPLACE_ACTIVATION_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    const list = stringList(ownValue(value, key));
    if (list === undefined) continue;
    defineOwn(result, key, list);
  }
  return result;
};

const strictnessOf = (action: unknown): number => (
  typeof action === 'string' && Object.hasOwn(STRICTNESS, action) ? STRICTNESS[action] : -1
);

/** Keep only actions at least as strict as `threshold`, raised to the floor. */
const strictPart = (value: unknown, threshold: number): unknown => {
  if (typeof value === 'string') {
    return strictnessOf(value) >= threshold ? value : undefined;
  }
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.some(([, action]) => strictnessOf(action) >= threshold)) return undefined;
  const floor = ACTION_BY_STRICTNESS[threshold];
  const raised: Record<string, unknown> = {};
  for (const [pattern, action] of entries) {
    defineOwn(
      raised,
      pattern,
      typeof action === 'string' && strictnessOf(action) < threshold ? floor : action,
    );
  }
  return raised;
};

/** Permission objects merge strictness-aware; everything else merges per key. */
const mergePermission = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const wildcard = ownValue(override, '*');
  const hasWildcard = typeof wildcard === 'string' && Object.hasOwn(STRICTNESS, wildcard);
  const threshold = STRICTNESS[hasWildcard ? (wildcard as string) : 'deny'];

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (Object.hasOwn(override, key)) continue;
    const strict = key === '*' ? undefined : strictPart(value, threshold);
    if (strict === undefined) defineOwn(before, key, value);
    else defineOwn(after, key, hasWildcard ? strict : value);
  }

  const result = before;
  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = ownValue(base, key);
    defineOwn(
      result,
      key,
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergePermission(baseValue, overrideValue)
        : overrideValue,
    );
  }
  for (const [key, value] of Object.entries(after)) defineOwn(result, key, value);
  return result;
};

/**
 * Recursively merge JSON objects. Override keys come first; base keys the
 * override does not mention follow. Arrays and scalars are replaced. Permission
 * objects merge through `mergePermission`.
 */
export const deepMerge = (base: unknown, override: unknown): unknown => {
  if (!base) return override;
  if (!override) return base;
  if (!isRecord(base) || !isRecord(override)) return override;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(override)) {
    const baseValue = ownValue(base, key);
    const overrideValue = ownValue(override, key);
    if (isRecord(baseValue) && isRecord(overrideValue)) {
      defineOwn(
        result,
        key,
        key === 'permission'
          ? mergePermission(baseValue, overrideValue)
          : deepMerge(baseValue, overrideValue),
      );
    } else {
      defineOwn(result, key, overrideValue);
    }
  }
  for (const key of Object.keys(base)) {
    if (!Object.hasOwn(result, key)) defineOwn(result, key, ownValue(base, key));
  }
  return result;
};

const canonicalizeAgentAliases = (
  agents: Record<string, AgentOverride>,
): Record<string, AgentOverride> => {
  const result: Record<string, AgentOverride> = {};
  for (const [name, override] of Object.entries(agents)) {
    if (!isUsableAgentName(name) || !isRecord(override)) continue;
    const canonicalName = aliasOf(name) ?? name;
    defineOwn(
      result,
      canonicalName,
      deepMerge(ownValue(result, canonicalName), override) as AgentOverride,
    );
  }
  for (const name of Object.keys(agents)) {
    const canonicalName = aliasOf(name);
    if (canonicalName === undefined) continue;
    if (!Object.hasOwn(agents, canonicalName)) continue;
    const canonicalValue = ownValue(agents, canonicalName);
    if (!isRecord(canonicalValue)) continue;
    defineOwn(
      result,
      canonicalName,
      deepMerge(ownValue(result, canonicalName), canonicalValue) as AgentOverride,
    );
  }
  return result;
};

/**
 * Merge agent layers while preserving the explicit model inheritance policy.
 * A missing model normally keeps the lower layer's model, while
 * `inheritModelFrom` intentionally clears it for later model resolution. The
 * directive is honored for canonical keys and for legacy alias keys.
 */
export const mergeAgentOverrides = (
  base: Record<string, AgentOverride>,
  override: Record<string, AgentOverride>,
): Record<string, AgentOverride> => {
  const safeBase = isRecord(base) ? (base as Record<string, AgentOverride>) : {};
  const safeOverride = isRecord(override) ? (override as Record<string, AgentOverride>) : {};
  const canonicalBase = canonicalizeAgentAliases(safeBase);
  const canonicalOverride = canonicalizeAgentAliases(safeOverride);
  const merged = (
    deepMerge(canonicalBase, canonicalOverride) ?? canonicalBase
  ) as Record<string, AgentOverride>;

  const canonicalInheritanceDirectives = new Set<string>();
  for (const [name] of Object.entries(safeOverride)) {
    const canonicalName = aliasOf(name) ?? name;
    if (canonicalName === name) continue;
    const canonicalValue = ownValue(safeOverride, canonicalName);
    if (!isRecord(canonicalValue)) continue;
    if (canonicalValue.model === undefined && canonicalValue.inheritModelFrom !== undefined) {
      canonicalInheritanceDirectives.add(canonicalName);
    }
  }

  for (const [name, agentOverride] of Object.entries(canonicalOverride)) {
    if (!isRecord(agentOverride)) continue;
    if (
      !canonicalInheritanceDirectives.has(name)
      && (agentOverride.model !== undefined || agentOverride.inheritModelFrom === undefined)
    ) {
      continue;
    }
    const entry = ownValue(merged, name);
    if (!isRecord(entry)) continue;
    const updatedEntry = { ...entry };
    delete updatedEntry.model;
    defineOwn(merged, name, updatedEntry as AgentOverride);
  }
  return merged;
};

/** Error raised when a selected preset cannot be resolved completely. */
export class PresetResolutionError extends Error {
  readonly kind: 'missing-parent' | 'cycle';
  readonly chain: readonly string[];

  constructor(kind: 'missing-parent' | 'cycle', chain: readonly string[]) {
    const message = kind === 'missing-parent'
      ? chain.length > 1
        ? `Preset "${chain[chain.length - 2]}" extends missing preset "${chain[chain.length - 1]}" (chain: ${chain.join(' -> ')})`
        : `Preset "${chain[0]}" was not found`
      : `Preset inheritance cycle detected: ${chain.join(' -> ')}`;
    super(message);
    this.name = 'PresetResolutionError';
    this.kind = kind;
    this.chain = [...chain];
  }
}

/** Convert every accepted external syntax to the canonical representation. */
export const normalizePreset = (input: unknown): NormalizedPreset => {
  if (isRecord(input) && usesStructuredPresetSyntax(input)) {
    const agents = agentMap(ownValue(input, 'agents'));
    const inlineEntries: Record<string, unknown> = {};
    for (const name of ownNamesOf(input)) {
      if (name === 'agents' || name === 'extends' || name === 'marketplace') continue;
      const value = ownValue(input, name);
      if (isRecord(value)) defineOwn(inlineEntries, name, value);
    }

    const normalized: NormalizedPreset = {
      agents: deepMerge(inlineEntries, agents) as Record<string, AgentOverride>,
    };
    const parent = ownValue(input, 'extends');
    if (typeof parent === 'string') normalized.extends = parent;
    const marketplace = normalizeMarketplace(ownValue(input, 'marketplace'));
    if (marketplace !== undefined) normalized.marketplace = marketplace;
    return normalized;
  }

  const record: Record<string, unknown> = isRecord(input) ? input : {};
  const parent = ownValue(record, 'extends');
  const hasParent = typeof parent === 'string';
  const marketplaceValue = ownValue(record, 'marketplace');
  const hasMarketplace = isMarketplaceActivation(marketplaceValue);

  const agents: Record<string, AgentOverride> = {};
  for (const name of ownNamesOf(record)) {
    if (name === 'extends' && hasParent) continue;
    if (name === 'marketplace' && hasMarketplace) continue;
    const value = ownValue(record, name);
    if (!isRecord(value)) continue;
    defineOwn(agents, name, value as AgentOverride);
  }

  const normalized: NormalizedPreset = { agents };
  if (hasParent) normalized.extends = parent as string;
  if (hasMarketplace) {
    const marketplace = normalizeMarketplace(marketplaceValue);
    if (marketplace !== undefined) normalized.marketplace = marketplace;
  }
  return normalized;
};

const mergeMarketplaceActivation = (
  base: MarketplaceActivation | undefined,
  override: MarketplaceActivation | undefined,
): MarketplaceActivation | undefined => {
  if (!base) return override;
  if (!override) return base;
  if (override.agents !== undefined) return override;

  const mergeDirectives = (
    previous: string[] | undefined,
    next: string[] | undefined,
    oppositeNext: string[] | undefined,
  ): string[] | undefined => (
    next === undefined
      ? previous?.filter((id) => !oppositeNext?.includes(id))
      : next.length === 0
        ? []
        : [
          ...new Set([
            ...(previous ?? []).filter((id) => !oppositeNext?.includes(id)),
            ...next,
          ]),
        ]
  );

  return {
    agents: override.agents ?? base.agents,
    agents_add: mergeDirectives(base.agents_add, override.agents_add, override.agents_remove),
    agents_remove: mergeDirectives(base.agents_remove, override.agents_remove, override.agents_add),
  };
};

const resolveMarketplaceActivation = (
  parent: MarketplaceActivation | undefined,
  declaration: MarketplaceActivation | undefined,
): MarketplaceActivation | undefined => {
  if (!parent && !declaration) return undefined;
  const ids = declaration?.agents ?? parent?.agents ?? [];
  const removed = new Set(declaration?.agents_remove ?? []);
  return {
    agents: [...new Set([...ids, ...(declaration?.agents_add ?? [])])].filter(
      (id) => !removed.has(id),
    ),
  };
};

const normalizePresetMap = (
  map: Record<string, unknown> | null | undefined,
): Record<string, NormalizedPreset> => {
  const result: Record<string, NormalizedPreset> = {};
  if (!isRecord(map)) return result;
  for (const name of ownNamesOf(map)) {
    if (!isUsableAgentName(name)) continue;
    defineOwn(result, name, normalizePreset(ownValue(map, name)));
  }
  return result;
};

/**
 * Merge preset declarations from layered config files. Agents merge through
 * `mergeAgentOverrides`, marketplace activation through
 * `mergeMarketplaceActivation`, and `extends` falls back to the base layer.
 * The result is always the canonical structured shape.
 */
export const mergePresetMaps = (
  base: Record<string, unknown> | null | undefined,
  override: Record<string, unknown> | null | undefined,
): Record<string, NormalizedPreset> => {
  if (!base) return normalizePresetMap(override);
  if (!override) return normalizePresetMap(base);
  if (!isRecord(base) || !isRecord(override)) {
    return normalizePresetMap(isRecord(base) ? base : override);
  }

  const result = normalizePresetMap(base);
  for (const name of ownNamesOf(override)) {
    if (!isUsableAgentName(name)) continue;
    const overrideInput = ownValue(override, name);
    const baseInput = ownValue(base, name);
    if (!baseInput) {
      defineOwn(result, name, normalizePreset(overrideInput));
      continue;
    }

    const normalizedBase = normalizePreset(baseInput);
    const normalizedOverride = normalizePreset(overrideInput);
    const merged: NormalizedPreset = {
      agents: mergeAgentOverrides(normalizedBase.agents, normalizedOverride.agents),
    };
    const marketplace = mergeMarketplaceActivation(
      normalizedBase.marketplace,
      normalizedOverride.marketplace,
    );
    if (marketplace !== undefined) merged.marketplace = marketplace;
    const parent = normalizedOverride.extends ?? normalizedBase.extends;
    if (parent !== undefined) merged.extends = parent;
    defineOwn(result, name, merged);
  }
  return result;
};

/**
 * Resolve one named preset with depth-first traversal. The cache is populated
 * only after a complete ancestor chain resolves, so a failed chain never leaves
 * a partially selected preset behind.
 */
export const resolvePresetDefinition = (
  name: string,
  presets: Record<string, unknown>,
): NormalizedPreset => {
  const cache = new Map<string, NormalizedPreset>();
  const visiting = new Set<string>();
  const stack: string[] = [];

  const visit = (current: string): NormalizedPreset => {
    const cached = cache.get(current);
    if (cached) return cached;

    const definition = isRecord(presets) ? ownValue(presets, current) : undefined;
    if (!definition) {
      throw new PresetResolutionError('missing-parent', [...stack, current]);
    }
    if (visiting.has(current)) {
      const cycleStart = stack.indexOf(current);
      throw new PresetResolutionError('cycle', [...stack.slice(cycleStart), current]);
    }

    visiting.add(current);
    stack.push(current);
    const normalized = normalizePreset(definition);
    const parent: NormalizedPreset = normalized.extends
      ? visit(normalized.extends)
      : { agents: {} };

    const resolved: NormalizedPreset = {
      agents: mergeAgentOverrides(parent.agents, normalized.agents),
    };
    if (normalized.extends !== undefined) resolved.extends = normalized.extends;
    const marketplace = resolveMarketplaceActivation(parent.marketplace, normalized.marketplace);
    if (marketplace !== undefined) resolved.marketplace = marketplace;
    stack.pop();
    visiting.delete(current);
    cache.set(current, resolved);
    return resolved;
  };

  return visit(name);
};
