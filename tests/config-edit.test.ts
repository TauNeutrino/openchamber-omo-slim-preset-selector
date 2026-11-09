import assert from 'node:assert/strict';
import test from 'node:test';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  addPresetToText,
  applyAgentModelToText,
  applyAgentPatchToText,
  parseConfigText,
  removeAgentFromText,
} from '../src/config.ts';

const parsedRoot = (text: string): Record<string, any> => {
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return parseJsonc(content, [], { allowTrailingComma: true }) as Record<string, any>;
};

const CONFIG = `{
  "preset": "default",
  "presets": {
    "default": {
      "orchestrator": { "model": "anthropic/claude-sonnet-4", "variant": "high" },
      "coder": { "model": "openai/gpt-4o" }
    },
    "wrapped": {
      "agents": {
        "orchestrator": { "model": "anthropic/claude-sonnet-4" }
      }
    }
  }
}`;

test('applyAgentModelToText changes model (direct form)', () => {
  const next = applyAgentModelToText(CONFIG, 'default', 'coder', 'google/gemini-2.5-pro');
  assert.match(next, /"coder": \{ "model": "google\/gemini-2.5-pro" \}/);
  assert.match(next, /"orchestrator": \{ "model": "anthropic\/claude-sonnet-4", "variant": "high" \}/);
});

test('applyAgentModelToText changes model (wrapped form)', () => {
  const next = applyAgentModelToText(CONFIG, 'wrapped', 'orchestrator', 'openai/gpt-4o', 'low');
  assert.match(next, /"model": "openai\/gpt-4o"/);
  assert.match(next, /"variant": "low"/);
});

test('applyAgentModelToText removes variant when empty', () => {
  const next = applyAgentModelToText(CONFIG, 'default', 'orchestrator', 'anthropic/claude-sonnet-4', '');
  assert.doesNotMatch(next, /"variant": "high"/);
});

test('applyAgentModelToText preserves comments', () => {
  const raw = `// top comment\n{\n  "preset": "default",\n  "presets": { "default": { "coder": { "model": "openai/gpt-4o" } } }\n}`;
  const next = applyAgentModelToText(raw, 'default', 'coder', 'google/gemini-2.5-pro');
  assert.match(next, /\/\/ top comment/);
});

test('applyAgentModelToText refuses unknown preset', () => {
  assert.throws(() => applyAgentModelToText(CONFIG, 'nope', 'coder', 'x/y'));
});

const CONFIG2 = `{
  "preset": "default",
  "presets": {
    "default": {
      "orchestrator": { "model": "anthropic/claude-sonnet-4", "variant": "high" }
    }
  }
}`;

test('addPresetToText adds a new preset', () => {
  const next = addPresetToText(CONFIG2, 'clone', [{ agent: 'orchestrator', models: [{ model: 'openai/gpt-4o' }] }]);
  assert.match(next, /"clone"/);
  assert.match(next, /"openai\/gpt-4o"/);
  assert.match(next, /"default"/);
});

test('addPresetToText refuses duplicate name', () => {
  assert.throws(() => addPresetToText(CONFIG2, 'default', [{ agent: 'orchestrator', models: [{ model: 'x/y' }] }]));
});

test('addPresetToText works on empty file', () => {
  const next = addPresetToText('', 'new', [{ agent: 'orchestrator', models: [{ model: 'a/b' }] }]);
  assert.match(next, /"presets"/);
  assert.match(next, /"new"/);
});

test('addPresetToText keeps a model chain a chain', () => {
  const next = addPresetToText(CONFIG2, 'chain', [{
    agent: 'oracle',
    models: [{ model: 'a/b', variant: 'high' }, { model: 'c/d' }, { model: 'e/f' }],
  }]);
  const parsed = parseConfigText(next, 'result');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.presets.chain, [{
    agent: 'oracle',
    models: [{ model: 'a/b', variant: 'high' }, { model: 'c/d' }, { model: 'e/f' }],
  }]);
});

const CHAIN = `{
  "preset": "chain",
  "presets": {
    "chain": {
      "agents": {
        "oracle": { "model": ["a/b", { "id": "c/d", "variant": "low" }], "variant": "high" }
      }
    }
  }
}`;

test('applyAgentModelToText replaces the primary and keeps the fallbacks', () => {
  const next = applyAgentModelToText(CHAIN, 'chain', 'oracle', 'e/f');
  const parsed = parseConfigText(next, 'result');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.presets.chain, [{
    agent: 'oracle',
    models: [{ model: 'e/f' }, { model: 'a/b' }, { model: 'c/d', variant: 'low' }],
    variant: 'high',
  }]);
});

test('applyAgentModelToText writes the variant into the chain entry', () => {
  const next = applyAgentModelToText(CHAIN, 'chain', 'oracle', 'e/f', 'max');
  const parsed = parseConfigText(next, 'result');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.presets.chain, [{
    agent: 'oracle',
    models: [{ model: 'e/f', variant: 'max' }, { model: 'a/b' }, { model: 'c/d', variant: 'low' }],
    variant: 'high',
  }]);
});

test('applyAgentModelToText does not duplicate a model already in the chain', () => {
  const next = applyAgentModelToText(CHAIN, 'chain', 'oracle', 'a/b');
  const parsed = parseConfigText(next, 'result');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.presets.chain[0].models, [
    { model: 'a/b' },
    { model: 'c/d', variant: 'low' },
  ]);
});

const STRUCTURED = `{
  "preset": "default",
  // keep me
  "presets": {
    "default": {
      "extends": "base",
      "agents": {
        "orchestrator": { "model": "anthropic/claude-sonnet-4", "variant": "high" },
        "coder": { "model": "openai/gpt-4o" }
      }
    },
    "sibling": {
      "agents": {
        "coder": { "model": "google/gemini-2.5-pro" }
      }
    }
  }
}`;

test('applyAgentPatchToText patches a structured preset in place', () => {
  const next = applyAgentPatchToText(STRUCTURED, { kind: 'preset', presetName: 'default' }, 'orchestrator', {
    models: [{ model: 'openai/gpt-5', variant: 'high' }, { model: 'openai/gpt-4o' }],
    temperature: 0.2,
    displayName: 'Lead',
    color: '#fff',
  });
  const root = parsedRoot(next);
  const orchestrator = root.presets.default.agents.orchestrator;
  assert.deepEqual(orchestrator.model, [
    { id: 'openai/gpt-5', variant: 'high' },
    'openai/gpt-4o',
  ]);
  assert.equal(orchestrator.temperature, 0.2);
  assert.equal(orchestrator.displayName, 'Lead');
  assert.equal(orchestrator.color, '#fff');
  assert.equal(root.presets.default.agents.coder.model, 'openai/gpt-4o');
  assert.equal(root.presets.sibling.agents.coder.model, 'google/gemini-2.5-pro');
  assert.deepEqual(Object.keys(orchestrator), [
    'model', 'variant', 'temperature', 'displayName', 'color',
  ]);
  assert.match(next, /\/\/ keep me/);
  const sibling = (text: string): string => text.slice(text.indexOf('"sibling"'));
  assert.equal(sibling(next), sibling(STRUCTURED));
});

const FLAT = `{
  "preset": "flat",
  "presets": {
    "flat": {
      "orchestrator": { "model": "a/b" },
      "coder": { "model": "c/d" }
    }
  }
}`;

test('applyAgentPatchToText patches a flat preset', () => {
  const next = applyAgentPatchToText(FLAT, { kind: 'preset', presetName: 'flat' }, 'coder', {
    models: [{ model: 'e/f' }],
    variant: 'low',
    skills: ['lint'],
  });
  const root = parsedRoot(next);
  assert.equal(root.presets.flat.coder.model, 'e/f');
  assert.equal(root.presets.flat.coder.variant, 'low');
  assert.deepEqual(root.presets.flat.coder.skills, ['lint']);
  assert.equal(root.presets.flat.orchestrator.model, 'a/b');
});

const ROOT = `{
  "agents": {
    "oracle": { "model": "a/b" },
    "designer": { "model": "c/d" }
  }
}`;

test('applyAgentPatchToText patches a root agent', () => {
  const next = applyAgentPatchToText(ROOT, { kind: 'root' }, 'oracle', {
    models: [{ model: 'e/f' }, { model: 'g/h', variant: 'low' }],
    mcps: ['github'],
    permission: { bash: 'deny', edit: { '*': 'ask' } },
  });
  const root = parsedRoot(next);
  assert.deepEqual(root.agents.oracle.model, ['e/f', { id: 'g/h', variant: 'low' }]);
  assert.deepEqual(root.agents.oracle.mcps, ['github']);
  assert.deepEqual(root.agents.oracle.permission, { bash: 'deny', edit: { '*': 'ask' } });
  assert.equal(root.agents.designer.model, 'c/d');
});

test('removeAgentFromText removes a root agent', () => {
  const next = removeAgentFromText(ROOT, { kind: 'root' }, 'oracle');
  const root = parsedRoot(next);
  assert.equal(Object.hasOwn(root.agents, 'oracle'), false);
  assert.equal(root.agents.designer.model, 'c/d');
});

const ONE_AGENT_WRAPPED = `{
  "presets": {
    "only": {
      "agents": {
        "oracle": { "model": "a/b" }
      }
    }
  }
}`;

test('removeAgentFromText keeps the empty preset agents wrapper', () => {
  const next = removeAgentFromText(ONE_AGENT_WRAPPED, { kind: 'preset', presetName: 'only' }, 'oracle');
  const root = parsedRoot(next);
  assert.equal(Object.hasOwn(root.presets.only, 'agents'), true);
  assert.deepEqual(root.presets.only.agents, {});
  assert.equal(Object.hasOwn(root.presets.only.agents, 'oracle'), false);
});

test('removeAgentFromText removes a flat preset agent', () => {
  const next = removeAgentFromText(FLAT, { kind: 'preset', presetName: 'flat' }, 'coder');
  const root = parsedRoot(next);
  assert.equal(Object.hasOwn(root.presets.flat, 'coder'), false);
  assert.equal(root.presets.flat.orchestrator.model, 'a/b');
});

const CHAIN_AGENT = `{
  "presets": {
    "chain": {
      "agents": {
        "oracle": { "model": ["a/b", { "id": "c/d", "variant": "low" }], "variant": "high" }
      }
    }
  }
}`;

test('applyAgentPatchToText writes a model chain', () => {
  const next = applyAgentPatchToText(CHAIN_AGENT, { kind: 'preset', presetName: 'chain' }, 'oracle', {
    models: [{ model: 'e/f', variant: 'max' }, { model: 'g/h' }],
  });
  const oracle = parsedRoot(next).presets.chain.agents.oracle;
  assert.deepEqual(oracle.model, [{ id: 'e/f', variant: 'max' }, 'g/h']);
  assert.equal(oracle.variant, 'high');
});

test('applyAgentPatchToText writes a single plain model as a string', () => {
  const next = applyAgentPatchToText(CHAIN_AGENT, { kind: 'preset', presetName: 'chain' }, 'oracle', {
    models: [{ model: 'e/f' }],
  });
  assert.equal(parsedRoot(next).presets.chain.agents.oracle.model, 'e/f');
});

test('applyAgentPatchToText removes the model with null', () => {
  const next = applyAgentPatchToText(CHAIN_AGENT, { kind: 'preset', presetName: 'chain' }, 'oracle', {
    models: null,
  });
  const oracle = parsedRoot(next).presets.chain.agents.oracle;
  assert.equal(Object.hasOwn(oracle, 'model'), false);
  assert.equal(oracle.variant, 'high');
});

test('applyAgentPatchToText removes the model with an empty chain', () => {
  const next = applyAgentPatchToText(CHAIN_AGENT, { kind: 'preset', presetName: 'chain' }, 'oracle', {
    models: [],
  });
  assert.equal(Object.hasOwn(parsedRoot(next).presets.chain.agents.oracle, 'model'), false);
});

test('applyAgentPatchToText with inheritModelFrom alone clears the model', () => {
  const next = applyAgentPatchToText(CHAIN_AGENT, { kind: 'preset', presetName: 'chain' }, 'oracle', {
    inheritModelFrom: 'session',
  });
  const oracle = parsedRoot(next).presets.chain.agents.oracle;
  assert.equal(Object.hasOwn(oracle, 'model'), false);
  assert.equal(oracle.inheritModelFrom, 'session');
  assert.equal(oracle.variant, 'high');
});

test('applyAgentPatchToText writes models and inheritModelFrom together', () => {
  const next = applyAgentPatchToText(CHAIN_AGENT, { kind: 'preset', presetName: 'chain' }, 'oracle', {
    models: [{ model: 'e/f' }],
    inheritModelFrom: 'orchestrator',
  });
  const oracle = parsedRoot(next).presets.chain.agents.oracle;
  assert.equal(oracle.model, 'e/f');
  assert.equal(oracle.inheritModelFrom, 'orchestrator');
});

const META = `{
  "agents": {
    "designer": {
      "model": "a/b",
      "variant": "high",
      "displayName": "Design",
      "color": "#abc"
    }
  }
}`;

test('applyAgentPatchToText removes variant, displayName and color with null', () => {
  const next = applyAgentPatchToText(META, { kind: 'root' }, 'designer', {
    variant: null,
    displayName: null,
    color: null,
  });
  const designer = parsedRoot(next).agents.designer;
  assert.equal(Object.hasOwn(designer, 'variant'), false);
  assert.equal(Object.hasOwn(designer, 'displayName'), false);
  assert.equal(Object.hasOwn(designer, 'color'), false);
  assert.equal(designer.model, 'a/b');
});

test('applyAgentPatchToText sets variant, displayName and color', () => {
  const next = applyAgentPatchToText(FLAT, { kind: 'preset', presetName: 'flat' }, 'orchestrator', {
    variant: ' max ',
    displayName: 'Lead',
    color: '#123456',
  });
  const orchestrator = parsedRoot(next).presets.flat.orchestrator;
  assert.equal(orchestrator.variant, 'max');
  assert.equal(orchestrator.displayName, 'Lead');
  assert.equal(orchestrator.color, '#123456');
});

const ARRAYS = `{
  "agents": {
    "coder": {
      "model": "a/b",
      "skills": ["old"],
      "skills_remove": ["stale"],
      "mcps": ["old-mcp"]
    }
  }
}`;

test('applyAgentPatchToText replaces arrays and writes permission verbatim', () => {
  const next = applyAgentPatchToText(ARRAYS, { kind: 'root' }, 'coder', {
    skills: ['lint', 'test'],
    skills_add: ['docs'],
    skills_remove: [],
    skills_include_local: true,
    mcps: ['github'],
    permission: { bash: 'deny', edit: { '*': 'ask', 'src/**': 'allow' } },
  });
  const coder = parsedRoot(next).agents.coder;
  assert.deepEqual(coder.skills, ['lint', 'test']);
  assert.deepEqual(coder.skills_add, ['docs']);
  assert.deepEqual(coder.skills_remove, []);
  assert.equal(coder.skills_include_local, true);
  assert.deepEqual(coder.mcps, ['github']);
  assert.deepEqual(coder.permission, { bash: 'deny', edit: { '*': 'ask', 'src/**': 'allow' } });
});

test('applyAgentPatchToText keeps an empty array as an empty array', () => {
  const next = applyAgentPatchToText(ARRAYS, { kind: 'root' }, 'coder', { skills: [] });
  assert.deepEqual(parsedRoot(next).agents.coder.skills, []);
  assert.match(next, /"skills": \[\]/);
});

test('applyAgentPatchToText removes array keys with null', () => {
  const next = applyAgentPatchToText(ARRAYS, { kind: 'root' }, 'coder', {
    skills: null,
    skills_remove: null,
    mcps: null,
  });
  const coder = parsedRoot(next).agents.coder;
  assert.equal(Object.hasOwn(coder, 'skills'), false);
  assert.equal(Object.hasOwn(coder, 'skills_remove'), false);
  assert.equal(Object.hasOwn(coder, 'mcps'), false);
  assert.equal(coder.model, 'a/b');
});

const TABBED = `{
\t// settings
\t"preset": "default",
\t"presets": {
\t\t"default": {
\t\t\t"agents": {
\t\t\t\t"orchestrator": {
\t\t\t\t\t"model": "a/b"
\t\t\t\t},
\t\t\t\t"coder": {
\t\t\t\t\t"model": "c/d"
\t\t\t\t}
\t\t\t}
\t\t}
\t}
}`;

test('applyAgentPatchToText keeps comments, key order, tabs and BOM', () => {
  const raw = `\uFEFF${TABBED}`;
  const next = applyAgentPatchToText(raw, { kind: 'preset', presetName: 'default' }, 'orchestrator', {
    temperature: 0.1,
  });
  assert.ok(next.startsWith('\uFEFF'));
  assert.match(next, /\/\/ settings/);
  assert.match(next, /\n\t{5}"temperature": 0\.1/);
  assert.match(next, /\n\t"preset": "default"/);
  assert.ok(next.indexOf('"orchestrator"') < next.indexOf('"coder"'));
  assert.equal(parseConfigText(next, 'result').ok, true);
  const tail = (text: string): string => text.slice(text.indexOf('"coder":'));
  assert.equal(tail(next), tail(raw));
});

test('applyAgentPatchToText refuses an unknown preset', () => {
  assert.throws(
    () => applyAgentPatchToText(STRUCTURED, { kind: 'preset', presetName: 'nope' }, 'coder', {
      temperature: 1,
    }),
    /Preset "nope"/,
  );
});

test('removeAgentFromText refuses an unknown preset', () => {
  assert.throws(
    () => removeAgentFromText(STRUCTURED, { kind: 'preset', presetName: 'nope' }, 'coder'),
    /Preset "nope"/,
  );
});

test('removeAgentFromText refuses an unknown agent', () => {
  assert.throws(() => removeAgentFromText(ROOT, { kind: 'root' }, 'nope'), /Agent "nope"/);
  assert.throws(
    () => removeAgentFromText(STRUCTURED, { kind: 'preset', presetName: 'default' }, 'nope'),
    /Agent "nope"/,
  );
});
