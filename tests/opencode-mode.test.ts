import assert from 'node:assert/strict';
import test from 'node:test';

import type { PresetAgent } from '../src/config.ts';
import {
  isSessionId,
  orchestratorTarget,
  parseOpenCodeVersion,
  splitModelRef,
  supportsLiveReload,
  switchModelBody,
  targetLabel,
} from '../src/opencode-mode.ts';

test('parseOpenCodeVersion reads the first x.y.z', () => {
  assert.deepEqual(parseOpenCodeVersion('opencode v2.3.2\n'), { version: '2.3.2', major: 2 });
  assert.deepEqual(parseOpenCodeVersion('1.14.7'), { version: '1.14.7', major: 1 });
  assert.equal(parseOpenCodeVersion('not a version'), null);
});

test('supportsLiveReload is v2 and later only; unknown keeps the v1 flow', () => {
  assert.equal(supportsLiveReload({ major: 2 }), true);
  assert.equal(supportsLiveReload({ major: 3 }), true);
  assert.equal(supportsLiveReload({ major: 1 }), false);
  assert.equal(supportsLiveReload({ major: null }), false);
  assert.equal(supportsLiveReload(null), false);
});

test('splitModelRef splits at the first slash only', () => {
  assert.deepEqual(splitModelRef('openai/gpt-6.1-sol'), { providerID: 'openai', id: 'gpt-6.1-sol' });
  assert.deepEqual(splitModelRef('freellmapi/auto:fast/pool'), { providerID: 'freellmapi', id: 'auto:fast/pool' });
  assert.equal(splitModelRef('no-slash'), null);
  assert.equal(splitModelRef('/model'), null);
  assert.equal(splitModelRef('provider/'), null);
});

const agent = (overrides: Partial<PresetAgent>): PresetAgent => ({ agent: 'orchestrator', models: [], ...overrides });

test('orchestratorTarget takes the primary model and the agent-level variant first', () => {
  const agents = [
    agent({ agent: 'explorer', models: [{ model: 'claude-agent/haiku' }] }),
    agent({ models: [{ model: 'claude-agent/opus', variant: 'medium' }, { model: 'openai/gpt-6.1-sol' }], variant: 'high' }),
  ] as PresetAgent[];
  assert.deepEqual(orchestratorTarget(agents), { agent: 'orchestrator', providerID: 'claude-agent', id: 'opus', variant: 'high' });
});

test('orchestratorTarget falls back to the chain variant and omits an empty one', () => {
  assert.deepEqual(
    orchestratorTarget([agent({ models: [{ model: 'openai/gpt-6.1-sol', variant: 'low' }] })] as PresetAgent[]),
    { agent: 'orchestrator', providerID: 'openai', id: 'gpt-6.1-sol', variant: 'low' },
  );
  assert.deepEqual(
    orchestratorTarget([agent({ models: [{ model: 'openai/gpt-6.1-sol' }] })] as PresetAgent[]),
    { agent: 'orchestrator', providerID: 'openai', id: 'gpt-6.1-sol' },
  );
});

test('orchestratorTarget is null without an orchestrator model', () => {
  assert.equal(orchestratorTarget(undefined), null);
  assert.equal(orchestratorTarget([agent({ agent: 'fixer', models: [{ model: 'openai/x' }] })] as PresetAgent[]), null);
  assert.equal(orchestratorTarget([agent({ models: [] })] as PresetAgent[]), null);
});

test('switchModelBody matches session.switchModel (id, providerID, variant only)', () => {
  assert.equal(
    switchModelBody({ providerID: 'openai', id: 'gpt-6-luna', variant: 'low' }),
    '{"model":{"id":"gpt-6-luna","providerID":"openai","variant":"low"}}',
  );
  assert.equal(switchModelBody({ providerID: 'openai', id: 'gpt-6-luna' }), '{"model":{"id":"gpt-6-luna","providerID":"openai"}}');
});

test('targetLabel shows the effort when set', () => {
  assert.equal(targetLabel({ agent: 'orchestrator', providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' }), 'openai/gpt-6.1-sol (high)');
  assert.equal(targetLabel({ agent: 'orchestrator', providerID: 'openai', id: 'gpt-6.1-sol' }), 'openai/gpt-6.1-sol');
});

test('isSessionId accepts OpenCode ids and rejects path tricks', () => {
  assert.equal(isSessionId('ses_df4edcc19ffeZPkoNdOEqtvfe8'), true);
  assert.equal(isSessionId('ses_../../api/location/reload'), false);
  assert.equal(isSessionId('abc'), false);
  assert.equal(isSessionId(42), false);
});
