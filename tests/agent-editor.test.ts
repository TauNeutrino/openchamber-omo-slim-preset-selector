import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftFromAgent,
  moveInChain,
  patchFromDraft,
  removeFromChain,
  setChainVariant,
  type AgentEditorDraft,
} from '../src/agent-editor.ts';
import type { PresetAgent } from '../src/config.ts';

const AGENT: PresetAgent = {
  agent: 'oracle',
  models: [{ model: 'a/b', variant: 'high' }, { model: 'c/d' }],
  variant: 'low',
  inheritModelFrom: 'orchestrator',
  temperature: 0.4,
  skills: [],
  skillsAdd: ['simplify'],
  mcps: ['ai-memory'],
  permission: { edit: 'allow' },
  displayName: 'Oracle',
  color: '#ff0000',
};

test('draftFromAgent carries every editor field and remembers what was present', () => {
  const draft = draftFromAgent(AGENT);
  assert.deepEqual(draft.chain, [{ model: 'a/b', variant: 'high' }, { model: 'c/d' }]);
  assert.equal(draft.variant, 'low');
  assert.equal(draft.inherit, 'orchestrator');
  assert.equal(draft.temperature, '0.4');
  assert.equal(draft.skills, '');
  assert.equal(draft.skillsAdd, 'simplify');
  assert.equal(draft.mcps, 'ai-memory');
  assert.equal(draft.permissionMode, 'json');
  assert.match(draft.permissionJson, /"edit": "allow"/);
  assert.equal(draft.displayName, 'Oracle');
  assert.equal(draft.color, '#ff0000');
  assert.ok(draft.present.includes('skills'));
  assert.ok(!draft.present.includes('skillsRemove'));
});

test('patchFromDraft turns blank text into removals and keeps explicit empty lists', () => {
  const draft = draftFromAgent(AGENT);
  const result = patchFromDraft(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch.models, [{ model: 'a/b', variant: 'high' }, { model: 'c/d' }]);
  assert.equal(result.patch.skills !== undefined && result.patch.skills !== null && result.patch.skills.length, 0);
  assert.equal(result.patch.skills_remove, null);
  assert.deepEqual(result.patch.mcps, ['ai-memory']);
  assert.deepEqual(result.patch.permission, { edit: 'allow' });
});

test('an absent list that stays blank is removed, not written as empty', () => {
  const draft = draftFromAgent({ agent: 'fixer', models: [] });
  const result = patchFromDraft(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patch.skills, null);
  assert.equal(result.patch.mcps, null);
  assert.equal(result.patch.variant, null);
  assert.equal(result.patch.inheritModelFrom, null);
  assert.equal(result.patch.skills_include_local, null);
});

test('skills_include_local is only written when checked or already present', () => {
  const absent = patchFromDraft({ ...draftFromAgent({ agent: 'x', models: [] }), skillsLocal: false });
  assert.equal(absent.ok && absent.patch.skills_include_local, null);
  const present = patchFromDraft({
    ...draftFromAgent({ agent: 'x', models: [] }),
    present: ['skillsLocal'],
    skillsLocal: false,
  });
  assert.equal(present.ok && present.patch.skills_include_local, false);
  const checked = patchFromDraft({ ...draftFromAgent({ agent: 'x', models: [] }), skillsLocal: true });
  assert.equal(checked.ok && checked.patch.skills_include_local, true);
});

test('permission modes round-trip and malformed JSON is reported', () => {
  const base = draftFromAgent({ agent: 'x', models: [] });
  const allow = patchFromDraft({ ...base, permissionMode: 'allow' });
  assert.equal(allow.ok && allow.patch.permission, 'allow');
  const none = patchFromDraft({ ...base, permissionMode: '' });
  assert.equal(none.ok && none.patch.permission, null);
  const bad = patchFromDraft({ ...base, permissionMode: 'json', permissionJson: '{oops' });
  assert.deepEqual(bad, { ok: false, error: 'permission' });
});

test('temperature is validated against the schema range', () => {
  const base = draftFromAgent({ agent: 'x', models: [] });
  assert.deepEqual(patchFromDraft({ ...base, temperature: '2.5' }), { ok: false, error: 'temperature' });
  assert.deepEqual(patchFromDraft({ ...base, temperature: 'abc' }), { ok: false, error: 'temperature' });
  const ok = patchFromDraft({ ...base, temperature: '1.25' });
  assert.equal(ok.ok && ok.patch.temperature, 1.25);
});

test('inheritModelFrom alone is passed through; the writer clears the model', () => {
  const draft: AgentEditorDraft = { ...draftFromAgent({ agent: 'x', models: [{ model: 'a/b' }] }), chain: [], inherit: 'session' };
  const result = patchFromDraft(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.patch.models, []);
  assert.equal(result.patch.inheritModelFrom, 'session');
});

test('chain helpers move, remove and set per-entry variants without mutating', () => {
  const chain = [{ model: 'a' }, { model: 'b', variant: 'low' }, { model: 'c' }];
  assert.deepEqual(moveInChain(chain, 0, 2).map((ref) => ref.model), ['b', 'c', 'a']);
  assert.deepEqual(chain.map((ref) => ref.model), ['a', 'b', 'c']);
  assert.deepEqual(removeFromChain(chain, 1).map((ref) => ref.model), ['a', 'c']);
  assert.deepEqual(setChainVariant(chain, 0, 'high'), [{ model: 'a', variant: 'high' }, { model: 'b', variant: 'low' }, { model: 'c' }]);
  assert.deepEqual(setChainVariant(chain, 1, ''), [{ model: 'a' }, { model: 'b' }, { model: 'c' }]);
  assert.deepEqual(moveInChain(chain, 5, 0), chain);
});
