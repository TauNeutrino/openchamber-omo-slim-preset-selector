import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { abortArgs, buildStopRecord, projectScopeHash, stopFilePath } from '../src/stop.ts';

test('projectScopeHash mirrors the plugin: sha256 of the resolved path, first 12 hex', () => {
  const directory = '/tmp/omo-project';
  const expected = createHash('sha256')
    .update(path.resolve(directory))
    .digest('hex')
    .slice(0, 12);
  assert.equal(projectScopeHash(directory), expected);
  assert.equal(projectScopeHash(relative(directory)), expected);
});

const relative = (absolute: string): string => path.relative(process.cwd(), absolute) || '.';

test('stopFilePath sits next to the plugin tui state, per project scope', () => {
  const file = stopFilePath('/home/u/.local/share', '/tmp/omo-project');
  assert.equal(
    file,
    path.join('/home/u/.local/share', 'opencode', 'storage', 'oh-my-opencode-slim', projectScopeHash('/tmp/omo-project'), 'kill-all-stop.json'),
  );
});

test('buildStopRecord keeps the timestamp and a deduped, non-empty parent list', () => {
  assert.deepEqual(buildStopRecord(['a', 'a', '', '  ', 'b'], 42), { at: 42, parents: ['a', 'b'] });
  assert.deepEqual(buildStopRecord([], 1), { at: 1, parents: [] });
});

test('abortArgs target the OpenCode api route for one session', () => {
  assert.deepEqual(abortArgs('ses_123'), ['api', 'POST', '/api/session/ses_123/abort']);
});
