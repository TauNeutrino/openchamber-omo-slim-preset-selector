import assert from 'node:assert/strict';
import test from 'node:test';
import { addPresetToText, applyAgentModelToText, parseConfigText } from '../src/config.ts';

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
