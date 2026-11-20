import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainContainsModel,
  draftFromAgent,
  isValidVariantName,
  moveInChain,
  normalizeVariantName,
  patchFromDraft,
  removeFromChain,
  setChainVariant,
  wizardApply,
  wizardChooseModel,
  wizardChooseVariant,
  wizardCommitCustom,
  wizardEntryOf,
  wizardIsUnchanged,
  type AgentEditorDraft,
  type EditorWizard,
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
  // The agent-level variant wins at runtime and is mirrored into the primary
  // entry, which is the only variant field the editor shows.
  assert.deepEqual(draft.chain, [{ model: 'a/b', variant: 'low' }, { model: 'c/d' }]);
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
  assert.deepEqual(result.patch.models, [{ model: 'a/b', variant: 'low' }, { model: 'c/d' }]);
  assert.equal(result.patch.variant, 'low');
  assert.equal(result.patch.skills !== undefined && result.patch.skills !== null && result.patch.skills.length, 0);
  assert.equal(result.patch.skills_remove, null);
  assert.deepEqual(result.patch.mcps, ['ai-memory']);
  assert.deepEqual(result.patch.permission, { edit: 'allow' });
});

test('an agent-level variant reaches the primary chain entry and survives a save', () => {
  // Regression: a destination without its own block falls back to the effective
  // agent, whose variant sits in the agent-level key. The chain used to show an
  // empty variant while the agent list showed it.
  const fallback = draftFromAgent({ agent: 'oracle', models: [{ model: 'github/gpt-5' }], variant: 'xhigh' });
  assert.equal(fallback.chain[0].variant, 'xhigh');
  const result = patchFromDraft(fallback);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patch.variant, 'xhigh');
  assert.deepEqual(result.patch.models, [{ model: 'github/gpt-5', variant: 'xhigh' }]);
});

test('clearing the primary entry variant clears the agent-level key as well', () => {
  const draft = draftFromAgent({ agent: 'oracle', models: [{ model: 'a/b' }], variant: 'high' });
  const cleared = patchFromDraft({ ...draft, chain: setChainVariant(draft.chain, 0, '') });
  assert.equal(cleared.ok, true);
  if (!cleared.ok) return;
  assert.equal(cleared.patch.variant, null);
  assert.deepEqual(cleared.patch.models, [{ model: 'a/b' }]);
});

test('a chain-less agent keeps its agent-level variant on save', () => {
  const draft = { ...draftFromAgent({ agent: 'oracle', models: [{ model: 'a/b' }], variant: 'max' }), chain: [] };
  const result = patchFromDraft(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patch.variant, 'max');
  assert.deepEqual(result.patch.models, []);
});

test('a variant that was not configured is still not written as an agent-level key', () => {
  const draft = draftFromAgent({ agent: 'observer', models: [{ model: 'a/b', variant: 'low' }] });
  const result = patchFromDraft(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.patch.variant, null);
  assert.deepEqual(result.patch.models, [{ model: 'a/b', variant: 'low' }]);
});

test('editing a chain-only variant does not invent an agent-level key', () => {
  const draft = draftFromAgent({ agent: 'observer', models: [{ model: 'a/b', variant: 'low' }] });
  const edited = patchFromDraft({ ...draft, chain: setChainVariant(draft.chain, 0, 'high') });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.patch.variant, null);
  assert.deepEqual(edited.patch.models, [{ model: 'a/b', variant: 'high' }]);
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

test('wizard variant names accept a-z, 0-9, dot, hyphen and underscore up to 24 chars', () => {
  assert.equal(normalizeVariantName('  XHigh '), 'xhigh');
  assert.equal(normalizeVariantName('thinking-2.1_fast'), 'thinking-2.1_fast');
  assert.equal(normalizeVariantName(''), null);
  assert.equal(normalizeVariantName('has space'), null);
  assert.equal(normalizeVariantName('-leading'), null);
  assert.equal(normalizeVariantName('a'.repeat(24)), 'a'.repeat(24));
  assert.equal(normalizeVariantName('a'.repeat(25)), null);
  assert.equal(isValidVariantName('HIGH'), true);
  assert.equal(isValidVariantName('with/slash'), false);
});

test('a model already in the chain is blocked except at the slot being replaced', () => {
  const chain = [{ model: 'a' }, { model: 'b' }, { model: 'c' }];
  assert.equal(chainContainsModel(chain, 'a'), true);
  assert.equal(chainContainsModel(chain, 'a', 0), false);
  assert.equal(chainContainsModel(chain, 'b', 0), true);
  assert.equal(chainContainsModel(chain, 'z'), false);
});

const wizardBase = (overrides: Partial<EditorWizard> = {}): EditorWizard => ({
  mode: 'replace',
  index: 0,
  step: 'model',
  model: null,
  variantKind: 'none',
  variant: null,
  customText: '',
  origModel: 'a',
  origVariant: 'high',
  lockedModel: false,
  ...overrides,
});

test('clicking a model jumps straight to the variant step, pre-selecting the old variant', () => {
  const picked = wizardChooseModel(wizardBase(), 'b');
  assert.equal(picked.step, 'variant');
  assert.equal(picked.model, 'b');
  assert.equal(picked.variantKind, 'none');
  const kept = wizardChooseModel(wizardBase(), 'a');
  assert.equal(kept.variantKind, 'pick');
  assert.equal(kept.variant, 'high');
});

test('picking none or a variant jumps to review; an invalid custom value does not', () => {
  const base = wizardBase({ step: 'variant', model: 'b' });
  const none = wizardChooseVariant(base, 'none', null);
  assert.equal(none.step, 'review');
  assert.equal(wizardEntryOf(none)?.variant, undefined);
  const picked = wizardChooseVariant(base, 'pick', 'low');
  assert.equal(picked.step, 'review');
  assert.equal(wizardEntryOf(picked)?.variant, 'low');
  assert.equal(wizardCommitCustom(base, 'bad value'), null);
  const custom = wizardCommitCustom(base, ' ULTRA ');
  assert.equal(custom?.step, 'review');
  assert.equal(wizardEntryOf(custom!)?.variant, 'ultra');
});

test('applying the wizard replaces or appends, blocks duplicates, and detects no-ops', () => {
  const chain = [{ model: 'a', variant: 'high' }, { model: 'b' }];
  const replaced = wizardApply(wizardBase({ step: 'review', model: 'c', variantKind: 'pick', variant: 'low' }), chain);
  assert.deepEqual(replaced?.chain, [{ model: 'c', variant: 'low' }, { model: 'b' }]);
  const appended = wizardApply(
    wizardBase({ mode: 'add-fallback', index: 2, step: 'review', model: 'c', origModel: null, origVariant: null }),
    chain,
  );
  assert.deepEqual(appended?.chain.map((ref) => ref.model), ['a', 'b', 'c']);
  assert.equal(appended?.index, 2);
  assert.equal(wizardApply(
    wizardBase({ mode: 'add-fallback', index: 2, step: 'review', model: 'a', origModel: null, origVariant: null }),
    chain,
  ), null);
  assert.equal(wizardIsUnchanged(wizardBase({ step: 'review', model: 'a', variantKind: 'pick', variant: 'high' }), chain), true);
  assert.equal(wizardIsUnchanged(wizardBase({ step: 'review', model: 'a', variantKind: 'none' }), chain), false);
});
