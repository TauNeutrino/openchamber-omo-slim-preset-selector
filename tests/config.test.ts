import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyPresetToText,
  clearPresetFromText,
  orchestratorModel,
  parseConfigText,
  planPresetSwitch,
  resolvePresetView,
  sortedPresetNames,
  type ParsedLayer,
  type PresetLayerKind,
} from '../src/config.ts';
import { setLocale } from '../src/i18n.ts';
setLocale('de');

const GLOBAL = '~/.config/opencode/oh-my-opencode-slim.json';
const PROJECT = '.opencode/oh-my-opencode-slim.json';

const layer = (
  kind: PresetLayerKind,
  path: string,
  raw: string,
): ParsedLayer => {
  const parsed = parseConfigText(raw, path);
  assert.equal(parsed.ok, true, parsed.ok ? undefined : parsed.error);
  if (!parsed.ok) throw new Error('unreachable');
  return { kind, path, raw, config: parsed.config };
};

const CONFIG = `{
  "$schema": "https://unpkg.com/oh-my-opencode-slim@latest/oh-my-opencode-slim.schema.json",
  "preset": "opencode-go",
  "presets": {
    "opencode-go": {
      "orchestrator": {
        "model": "opencode-go/glm-5.3-flash",
        "variant": "high"
      },
      "fixer": {
        "model": "opencode-go/deepseek-v4.1-flash"
      }
    },
    "free": {
      "orchestrator": {
        "model": "opencode/glm-5.3-flash-free"
      }
    }
  }
}
`;

test('parses the global .json shape with variants', () => {
  const parsed = parseConfigText(CONFIG, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.preset, 'opencode-go');
  assert.deepEqual(parsed.config.presetNames, ['opencode-go', 'free']);
  assert.equal(parsed.config.hasPresets, true);
  assert.deepEqual(parsed.config.presets['opencode-go'][0], {
    agent: 'orchestrator',
    models: [{ model: 'opencode-go/glm-5.3-flash' }],
    variant: 'high',
  });
  assert.deepEqual(parsed.config.presets.free, [
    { agent: 'orchestrator', models: [{ model: 'opencode/glm-5.3-flash-free' }] },
  ]);
});

test('parses .jsonc with comments and a trailing comma', () => {
  const raw = `{
    // Which preset is active.
    "preset": "free",
    "presets": {
      "free": { "orchestrator": { "model": "opencode/glm-5.3-flash-free" } }, // last
    },
  }`;
  const parsed = parseConfigText(raw, 'oh-my-opencode-slim.jsonc');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.preset, 'free');
  assert.deepEqual(parsed.config.presetNames, ['free']);
});

test('keeps a preset name whose block has no usable agent', () => {
  const raw = '{ "presets": { "half": { "orchestrator": { "model": "" } } } }';
  const parsed = parseConfigText(raw, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.config.presetNames, ['half']);
  assert.deepEqual(parsed.config.presets.half, []);
});

test('reports unparseable files with a location', () => {
  const parsed = parseConfigText('{ "preset": "free", } trailing', GLOBAL);
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.match(parsed.error, /ungültiges JSONC/);
  assert.match(parsed.error, /offset/);
});

test('rejects a non-object root and invalid preset keys', () => {
  const array = parseConfigText('[]', GLOBAL);
  assert.equal(array.ok, false);
  const preset = parseConfigText('{ "preset": 42 }', GLOBAL);
  assert.equal(preset.ok, false);
  const presets = parseConfigText('{ "presets": [] }', GLOBAL);
  assert.equal(presets.ok, false);
});

test('treats a comment-only file as an empty config', () => {
  const parsed = parseConfigText('// nothing yet\n', GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.commentOnly, true);
  assert.equal(parsed.config.preset, null);
});

test('changes only the preset value and keeps ordering and formatting', () => {
  const next = applyPresetToText(CONFIG, 'free');
  assert.equal(next.includes('"preset": "free"'), true);
  const before = CONFIG.split('\n');
  const after = next.split('\n');
  assert.equal(after.length, before.length);
  const changed = before
    .map((line, index) => (line === after[index] ? null : index))
    .filter((index): index is number => index !== null);
  assert.deepEqual(changed, [2]);
});

test('keeps JSONC comments, trailing commas and order', () => {
  const raw = `{
  // header comment
  "$schema": "schema.json",
  "preset": "opencode-go", // active
  "presets": {
    "free": { "orchestrator": { "model": "free/model" } },
    "opencode-go": { "orchestrator": { "model": "go/model", "variant": "high" }, },
  },
  "theme": "dark",
}
`;
  const next = applyPresetToText(raw, 'free');
  assert.equal(next.includes('// header comment'), true);
  assert.equal(next.includes('// active'), true);
  assert.equal(next.includes('"theme": "dark",'), true);
  assert.equal(next.includes('"preset": "free"'), true);
  assert.equal(next.includes('"variant": "high"'), true);
  assert.deepEqual(
    next.split('\n').filter((line) => line.includes('presets')),
    raw.split('\n').filter((line) => line.includes('presets')),
  );
});

test('inserts the preset key when the file does not have one', () => {
  const raw = `{
  "$schema": "schema.json",
  "presets": {
    "free": { "orchestrator": { "model": "free/model" } }
  }
}
`;
  const next = applyPresetToText(raw, 'free');
  // A new key goes after the existing ones, so their order is untouched.
  assert.equal(next, `{
  "$schema": "schema.json",
  "presets": {
    "free": { "orchestrator": { "model": "free/model" } }
  },
  "preset": "free"
}
`);
});

test('inserts into an empty .jsonc root and keeps its comments', () => {
  const raw = `// my presets
{
  // only presets, no active one
}
`;
  const next = applyPresetToText(raw, 'free');
  assert.match(next, /^\/\/ my presets\n\{\n {2}"preset": "free"\n/);
  assert.equal(next.includes('// only presets, no active one'), true);
});

test('appends a root object below a comment-only file', () => {
  const next = applyPresetToText('// keep me\n', 'free');
  assert.equal(next, '// keep me\n{\n  "preset": "free"\n}\n');
});

test('preserves CRLF line endings', () => {
  const raw = '{\r\n  "preset": "old",\r\n  "presets": {\r\n    "new": {}\r\n  }\r\n}\r\n';
  const next = applyPresetToText(raw, 'new');
  assert.equal(next.includes('"preset": "new"'), true);
  assert.equal(next.includes('\n') && !next.includes('\r\n'), false);
  assert.equal(next.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(parseConfigText(next, GLOBAL).ok, true);
});

test('preserves a BOM', () => {
  const raw = `\uFEFF${CONFIG}`;
  const next = applyPresetToText(raw, 'free');
  assert.equal(next.startsWith('\uFEFF'), true);
  assert.equal(next.slice(1).startsWith('{'), true);
});

test('follows a four-space indentation when inserting', () => {
  const raw = '{\n    "$schema": "schema.json",\n    "presets": {}\n}\n';
  const next = applyPresetToText(raw, 'free');
  assert.match(next, /"presets": \{\},\n {4}"preset": "free"\n/);
});

test('refuses to write when the file cannot be parsed or verified', () => {
  assert.throws(() => applyPresetToText('{ "preset": "free"', GLOBAL), /ungültiges JSONC/);
  assert.throws(() => applyPresetToText(CONFIG, '   '), /nicht leer/);
  assert.throws(() => applyPresetToText('[]', GLOBAL), /JSON-Objekt/);
});

test('resolves the global preset when there is no project layer', () => {
  const result = resolvePresetView(layer('global', GLOBAL, CONFIG), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.active, { name: 'opencode-go', origin: 'global' });
  assert.equal(result.view.agents.length, 2);
  assert.equal(result.view.activePath, GLOBAL);
});

test('reads a preset that wraps its agent map in an agents key', () => {
  const raw = `{
    "preset": "nested",
    "presets": {
      "nested": {
        "agents": {
          "orchestrator": {
            "model": "github-copilot/gpt-6-luna-275k",
            "variant": "high"
          },
          "oracle": { "model": "github-copilot/gpt-6.1-sol" }
        },
        "marketplace": { "agents": ["alvin/janitor"] }
      }
    }
  }`;
  const result = resolvePresetView(layer('global', GLOBAL, raw), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.active, { name: 'nested', origin: 'global' });
  assert.deepEqual(result.view.agents, [
    { agent: 'orchestrator', models: [{ model: 'github-copilot/gpt-6-luna-275k' }], variant: 'high' },
    { agent: 'oracle', models: [{ model: 'github-copilot/gpt-6.1-sol' }] },
  ]);
});

test('reads fallback chains and per-entry variants', () => {
  const raw = `{
    "preset": "chain",
    "presets": {
      "chain": {
        "agents": {
          "oracle": {
            "model": [{ "id": "magpie/agy-cli/gemini-4-argon", "variant": "high" }, "magpie/grok/grok-4.6", { "id": "opencode-go/glm-5.3" }],
            "skills": ["simplify"]
          },
          "fixer": { "model": "opencode-go/deepseek-v4.1-flash" },
          "helper": { "inheritModelFrom": "orchestrator" }
        },
        "marketplace": { "agents": ["alvin/validator"] }
      }
    }
  }`;
  const result = resolvePresetView(layer('global', GLOBAL, raw), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.agents, [
    { agent: 'oracle', models: [
      { model: 'magpie/agy-cli/gemini-4-argon', variant: 'high' },
      { model: 'magpie/grok/grok-4.6' },
      { model: 'opencode-go/glm-5.3' },
    ], skills: ['simplify'] },
    { agent: 'fixer', models: [{ model: 'opencode-go/deepseek-v4.1-flash' }] },
    { agent: 'helper', models: [], inheritModelFrom: 'orchestrator' },
  ]);
});

test('does not surface the marketplace block of a flat preset as an agent', () => {
  const raw = `{
    "preset": "flat",
    "presets": {
      "flat": {
        "marketplace": { "agents": ["alvin/validator"] },
        "orchestrator": { "model": "opencode-go/glm-5.3" }
      }
    }
  }`;
  const result = resolvePresetView(layer('global', GLOBAL, raw), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.agents, [
    { agent: 'orchestrator', models: [{ model: 'opencode-go/glm-5.3' }] },
  ]);
});

test('the project override wins and plans a project write', () => {
  const projectRaw = '{ "preset": "free" }';
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, projectRaw);
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.active, { name: 'free', origin: 'project' });
  assert.equal(result.view.globalPreset, 'opencode-go');
  assert.equal(result.view.projectPreset, 'free');
  assert.deepEqual(result.view.agents, [
    { agent: 'orchestrator', models: [{ model: 'opencode/glm-5.3-flash-free' }] },
  ]);
  const plan = planPresetSwitch({ scope: 'project', name: 'free', projectPath: PROJECT, global, project });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;
  assert.equal(plan.path, PROJECT);
  assert.deepEqual(plan.names, ['opencode-go', 'free']);
});

test('a project preset map merges with the global one', () => {
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, '{ "preset": "local", "presets": { "local": { "oracle": { "model": "x/y" } } } }');
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.origins, {
    'opencode-go': 'global',
    free: 'global',
    local: 'project',
  });
  // A global preset stays selectable in the project layer; the maps merge.
  const plan = planPresetSwitch({ scope: 'project', name: 'free', projectPath: PROJECT, global, project });
  assert.equal(plan.ok, true);
});

test('a partial project override keeps the base agents of the preset', () => {
  const global = layer('global', GLOBAL, `{
    "preset": "p",
    "presets": { "p": { "orchestrator": { "model": "a/b" }, "oracle": { "model": "c/d" } } }
  }`);
  const project = layer('project', PROJECT, `{
    "preset": "p",
    "presets": { "p": { "oracle": { "model": "e/f" } } }
  }`);
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.view.origins.p, 'both');
  assert.deepEqual(result.view.agents, [
    { agent: 'oracle', models: [{ model: 'e/f' }] },
    { agent: 'orchestrator', models: [{ model: 'a/b' }] },
  ]);
});

test('resolves preset inheritance and reports the parent', () => {
  const raw = `{
    "preset": "child",
    "presets": {
      "base": { "orchestrator": { "model": "a/b" }, "oracle": { "model": "c/d" } },
      "child": { "extends": "base", "oracle": { "model": "e/f" } },
      "deep": { "extends": "child", "fixer": { "model": "g/h" } }
    }
  }`;
  const result = resolvePresetView(layer('global', GLOBAL, raw), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.parents, { base: null, child: 'base', deep: 'child' });
  assert.deepEqual(result.view.presets.deep, [
    { agent: 'fixer', models: [{ model: 'g/h' }] },
    { agent: 'oracle', models: [{ model: 'e/f' }] },
    { agent: 'orchestrator', models: [{ model: 'a/b' }] },
  ]);
});

test('a broken inheritance is reported without locking the view', () => {
  const raw = '{ "preset": "child", "presets": { "child": { "extends": "missing", "oracle": { "model": "a/b" } } } }';
  const result = resolvePresetView(layer('global', GLOBAL, raw), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.agents, []);
  assert.match(result.view.errors.child, /missing/);
});

test('root agents sit above the active preset', () => {
  const raw = `{
    "preset": "p",
    "agents": { "oracle": { "model": "root/model" } },
    "presets": { "p": { "oracle": { "model": "preset/model" }, "fixer": { "model": "f/m" } } }
  }`;
  const result = resolvePresetView(layer('global', GLOBAL, raw), null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.view.agents, [
    { agent: 'oracle', models: [{ model: 'root/model' }], source: 'root' },
    { agent: 'fixer', models: [{ model: 'f/m' }] },
  ]);
  // Editing or cloning a preset must use its own agents, not the root overlay.
  assert.deepEqual(result.view.presets.p, [
    { agent: 'oracle', models: [{ model: 'preset/model' }] },
    { agent: 'fixer', models: [{ model: 'f/m' }] },
  ]);
});

test('an unknown project preset is refused', () => {
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, '{ "preset": "nope" }');
  const result = resolvePresetView(global, project);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /"nope" ist in \.opencode\/oh-my-opencode-slim\.json nicht definiert/);
});

test('the switch scope decides the file and refuses impossible targets', () => {
  const global = layer('global', GLOBAL, CONFIG);
  const project = layer('project', PROJECT, '{ "preset": "free", "presets": { "local": { "oracle": { "model": "x/y" } } } }');

  const projectOnlyToGlobal = planPresetSwitch({ scope: 'global', name: 'local', projectPath: PROJECT, global, project });
  assert.equal(projectOnlyToGlobal.ok, false);
  if (!projectOnlyToGlobal.ok) assert.equal(projectOnlyToGlobal.code, 'not-in-global');

  const closedProject = planPresetSwitch({ scope: 'project', name: 'free', projectPath: null, global, project: null });
  assert.equal(closedProject.ok, false);
  if (!closedProject.ok) assert.equal(closedProject.code, 'no-project');

  const emptyProject = layer('project', PROJECT, '{ "presets": { "empty": {} } }');
  const empty = planPresetSwitch({ scope: 'project', name: 'empty', projectPath: PROJECT, global, project: emptyProject });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 'empty-preset');

  const okGlobal = planPresetSwitch({ scope: 'global', name: 'free', projectPath: PROJECT, global, project });
  assert.equal(okGlobal.ok, true);
  if (okGlobal.ok) assert.equal(okGlobal.path, GLOBAL);

  const okProject = planPresetSwitch({ scope: 'project', name: 'free', projectPath: PROJECT, global, project });
  assert.equal(okProject.ok, true);
  if (okProject.ok) assert.equal(okProject.path, PROJECT);
});

test('clearing the project override leaves the rest of the file intact', () => {
  const raw = '{ "preset": "free", "presets": { "local": { "oracle": { "model": "x/y" } } } }';
  const next = clearPresetFromText(raw);
  const parsed = parseConfigText(next, PROJECT);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.config.preset, null);
  assert.deepEqual(parsed.config.presetNames, ['local']);
});

test('an unknown global preset is refused', () => {
  const result = resolvePresetView(layer('global', GLOBAL, '{ "preset": "gone", "presets": {} }'), null);
  assert.equal(result.ok, false);
});

test('a missing preset key is refused', () => {
  const result = resolvePresetView(layer('global', GLOBAL, '{ "presets": { "free": {} } }'), null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /kein Preset gesetzt/);
});

test('sorted names and the orchestrator hint', () => {
  const parsed = parseConfigText(CONFIG, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(sortedPresetNames(parsed.config.presets), ['free', 'opencode-go']);
  assert.equal(orchestratorModel(parsed.config.presets, 'opencode-go'), 'opencode-go/glm-5.3-flash');
  assert.equal(orchestratorModel(parsed.config.presets, 'missing'), null);
});

test('the orchestrator hint uses the primary model of a chain', () => {
  const raw = '{ "presets": { "p": { "agents": { "orchestrator": { "model": ["a/b", "c/d"] } } } } }';
  const parsed = parseConfigText(raw, GLOBAL);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(orchestratorModel(parsed.config.presets, 'p'), 'a/b');
});
