import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PresetResolutionError,
  deepMerge,
  mergeAgentOverrides,
  mergePresetMaps,
  normalizePreset,
  resolvePresetDefinition,
} from '../src/preset-merge.ts';

const captureError = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
};

test('normalizes a flat preset and hoists extends plus marketplace activation', () => {
  const normalized = normalizePreset({
    extends: 'base',
    orchestrator: { model: 'opencode-go/glm-5.3-flash' },
    fixer: { temperature: 0.2 },
    marketplace: { agents_add: ['author/package'] },
  });

  assert.deepEqual(normalized, {
    extends: 'base',
    agents: {
      orchestrator: { model: 'opencode-go/glm-5.3-flash' },
      fixer: { temperature: 0.2 },
    },
    marketplace: { agents_add: ['author/package'] },
  });
});

test('keeps a flat agent named marketplace when it carries no activation directive', () => {
  assert.deepEqual(normalizePreset({ marketplace: { model: 'openai/gpt-5' } }), {
    agents: { marketplace: { model: 'openai/gpt-5' } },
  });
});

test('folds inline keys of a structured preset under agents', () => {
  const normalized = normalizePreset({
    extends: 'base',
    agents: {
      orchestrator: { model: 'openai/gpt-5' },
      fixer: { temperature: 0.3 },
    },
    oracle: { model: 'anthropic/claude' },
    marketplace: { agents: ['author/package'] },
  });

  assert.deepEqual(normalized, {
    extends: 'base',
    agents: {
      orchestrator: { model: 'openai/gpt-5' },
      fixer: { temperature: 0.3 },
      oracle: { model: 'anthropic/claude' },
    },
    marketplace: { agents: ['author/package'] },
  });
});

test('deep-merges agents, replaces arrays, and merges permission strictness', () => {
  const merged = mergeAgentOverrides(
    {
      fixer: {
        model: 'base/model',
        temperature: 0.1,
        skills: ['one', 'two'],
        options: { nested: { keep: 1, replace: 'base' } },
        permission: {
          bash: { 'rm -rf *': 'deny', 'git status': 'allow' },
          edit: 'allow',
        },
      },
    },
    {
      fixer: {
        temperature: 0.5,
        skills: ['three'],
        options: { nested: { replace: 'override' } },
        permission: { bash: { '*': 'deny' } },
      },
    },
  );

  assert.deepEqual(merged, {
    fixer: {
      model: 'base/model',
      temperature: 0.5,
      skills: ['three'],
      options: { nested: { keep: 1, replace: 'override' } },
      permission: {
        edit: 'allow',
        bash: {
          'git status': 'allow',
          '*': 'deny',
          'rm -rf *': 'deny',
        },
      },
    },
  });
});

test('inheritModelFrom without model clears the inherited model', () => {
  assert.deepEqual(
    mergeAgentOverrides(
      {
        explorer: { model: 'base/explorer', temperature: 0.1 },
        oracle: { model: 'base/oracle' },
      },
      { explorer: { inheritModelFrom: 'session' } },
    ),
    {
      explorer: { temperature: 0.1, inheritModelFrom: 'session' },
      oracle: { model: 'base/oracle' },
    },
  );
});

test('inheritModelFrom clears the model through a legacy alias key', () => {
  assert.deepEqual(
    mergeAgentOverrides(
      { explorer: { model: 'base/explorer', temperature: 0.1 } },
      { explore: { inheritModelFrom: 'orchestrator' } },
    ),
    { explorer: { temperature: 0.1, inheritModelFrom: 'orchestrator' } },
  );
});

test('mergePresetMaps keeps base agents, one-layer presets, and inherits extends', () => {
  const merged = mergePresetMaps(
    {
      baseOnly: { oracle: { model: 'base/oracle' } },
      shared: { extends: 'base', fixer: { model: 'base/fixer' } },
    },
    {
      overrideOnly: { designer: { model: 'override/designer' } },
      shared: { fixer: { temperature: 0.4 } },
    },
  );

  assert.deepEqual(merged.baseOnly, { agents: { oracle: { model: 'base/oracle' } } });
  assert.deepEqual(merged.overrideOnly, {
    agents: { designer: { model: 'override/designer' } },
  });
  assert.deepEqual(merged.shared, {
    extends: 'base',
    agents: { fixer: { model: 'base/fixer', temperature: 0.4 } },
  });
  assert.equal(merged.shared.extends, 'base');
});

test('mergePresetMaps: marketplace agents replace, add/remove combine, removal wins', () => {
  const replaced = mergePresetMaps(
    { p: { marketplace: { agents: ['base/one'], agents_add: ['base/two'] } } },
    { p: { marketplace: { agents: ['next/one'], agents_remove: ['base/one'] } } },
  );
  assert.deepEqual(replaced.p.marketplace, {
    agents: ['next/one'],
    agents_remove: ['base/one'],
  });

  const combined = mergePresetMaps(
    {
      p: {
        marketplace: {
          agents: ['base/keep', 'base/removed'],
          agents_add: ['base/add'],
          agents_remove: ['base/gone'],
        },
      },
    },
    {
      p: {
        marketplace: {
          agents_add: ['next/add', 'base/removed'],
          agents_remove: ['base/keep'],
        },
      },
    },
  );
  assert.deepEqual(combined.p.marketplace, {
    agents: ['base/keep', 'base/removed'],
    agents_add: ['base/add', 'next/add', 'base/removed'],
    agents_remove: ['base/gone', 'base/keep'],
  });

  const resolved = resolvePresetDefinition('p', combined);
  assert.deepEqual(resolved.marketplace, {
    agents: ['base/removed', 'base/add', 'next/add'],
  });
});

test('resolvePresetDefinition merges the parent agents under the child, child model wins', () => {
  const resolved = resolvePresetDefinition('child', {
    base: {
      agents: {
        fixer: { model: 'base/fixer', temperature: 0.1, skills: ['base'] },
        explorer: { model: 'base/explorer' },
      },
      marketplace: { agents: ['author/one'] },
    },
    child: {
      extends: 'base',
      agents: {
        fixer: { model: 'child/fixer' },
        designer: { model: 'child/designer' },
      },
      marketplace: { agents_add: ['author/two'] },
    },
  });

  assert.deepEqual(resolved, {
    extends: 'base',
    agents: {
      fixer: { model: 'child/fixer', temperature: 0.1, skills: ['base'] },
      explorer: { model: 'base/explorer' },
      designer: { model: 'child/designer' },
    },
    marketplace: { agents: ['author/one', 'author/two'] },
  });
});

test('resolvePresetDefinition throws missing-parent with the chain', () => {
  const error = captureError(() => resolvePresetDefinition('child', {
    child: { extends: 'ghost' },
  }));

  assert.ok(error instanceof PresetResolutionError);
  assert.equal(error.kind, 'missing-parent');
  assert.deepEqual(error.chain, ['child', 'ghost']);

  const nested = captureError(() => resolvePresetDefinition('a', {
    a: { extends: 'b' },
    b: { extends: 'ghost' },
  }));

  assert.ok(nested instanceof PresetResolutionError);
  assert.equal(nested.kind, 'missing-parent');
  assert.deepEqual(nested.chain, ['a', 'b', 'ghost']);
});

test('resolvePresetDefinition detects a cycle with the chain', () => {
  const error = captureError(() => resolvePresetDefinition('a', {
    a: { extends: 'b' },
    b: { extends: 'a' },
  }));

  assert.ok(error instanceof PresetResolutionError);
  assert.equal(error.kind, 'cycle');
  assert.deepEqual(error.chain, ['a', 'b', 'a']);
});

test('deepMerge leaves both inputs untouched', () => {
  const base = { agent: { model: 'base', skills: ['a'], nested: { keep: 1 } }, list: [1] };
  const override = { agent: { skills: ['b'], nested: { add: 2 } }, list: [2] };
  const baseSnapshot = JSON.parse(JSON.stringify(base));
  const overrideSnapshot = JSON.parse(JSON.stringify(override));

  const merged = deepMerge(base, override);

  assert.deepEqual(base, baseSnapshot);
  assert.deepEqual(override, overrideSnapshot);
  assert.deepEqual(merged, {
    agent: { model: 'base', skills: ['b'], nested: { keep: 1, add: 2 } },
    list: [2],
  });
});

test('prototype-sensitive keys stay own data properties', () => {
  const input = JSON.parse(
    '{"__proto__":{"model":"evil/model"},"fixer":{"model":"good/model"}}',
  ) as Record<string, unknown>;
  const normalized = normalizePreset(input);

  assert.equal(({} as Record<string, unknown>).model, undefined);
  assert.deepEqual(normalized.agents.fixer, { model: 'good/model' });
  assert.deepEqual(normalized.agents['__proto__'], { model: 'evil/model' });
});
