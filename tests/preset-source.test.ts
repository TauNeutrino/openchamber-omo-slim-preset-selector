import assert from 'node:assert/strict';
import test from 'node:test';

import { setLocale } from '../src/i18n.ts';
import { validatePresetSource } from '../src/preset-source.ts';

setLocale('en');

test('accepts a valid oMo Slim source file', () => {
  const result = validatePresetSource(`{
    // JSONC comments and trailing commas are supported.
    "presets": {
      "default": {
        "orchestrator": { "model": "provider/model" },
      },
    },
  }`);

  assert.deepEqual(result, { ok: true });
});

test('reports invalid JSONC with a parser message and position', () => {
  const result = validatePresetSource('{\n  "presets": {\n    "broken":\n  }\n}');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /Invalid JSONC/);
  assert.equal(typeof result.line, 'number');
  assert.equal(typeof result.column, 'number');
  assert.ok((result.line ?? 0) > 0);
  assert.ok((result.column ?? 0) > 0);
});

test('rejects an array at the root', () => {
  const result = validatePresetSource('[]');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /root must be a JSON object/i);
});

test('rejects a source without the presets key', () => {
  const result = validatePresetSource('{ "preset": "default" }');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /“presets” key is missing/i);
});

test('rejects a presets value that is not an object', () => {
  const result = validatePresetSource('{ "presets": [] }');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /“presets” must be an object/i);
});

test('rejects a preset entry whose value is not an object', () => {
  const result = validatePresetSource('{ "presets": { "broken": [] } }');

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /Preset “broken” must be an object/i);
});
