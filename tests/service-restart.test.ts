import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  managedConfigFromEnviron,
  managedConfigPath,
  parseRegistryFile,
  pickManagedPids,
  type RegistryCandidate,
} from '../src/service-restart.ts';

const HOME = path.resolve('/home/tester');
const MANAGED = path.join(HOME, '.config/openchamber/run/instances/42/opencode.managed.json');

test('only OPENCODE_CONFIG under run/instances/<id> counts as managed', async () => {
  assert.equal(await managedConfigPath(MANAGED, async (value) => value, HOME), MANAGED);
  assert.equal(
    await managedConfigPath('~/.config/openchamber/run/instances/7/opencode.managed.json', async (value) => value, HOME),
    path.join(HOME, '.config/openchamber/run/instances/7/opencode.managed.json'),
  );
  assert.equal(await managedConfigPath(`${HOME}/.config/opencode/oh-my-opencode-slim.json`, async (value) => value, HOME), null);
  assert.equal(await managedConfigPath('/tmp/opencode.managed.json', async (value) => value, HOME), null);
  assert.equal(await managedConfigPath(`${HOME}/run/instances/x/opencode.managed.json`, async (value) => value, HOME), null);
  assert.equal(await managedConfigPath(undefined, async (value) => value, HOME), null);
});

test('the realpath result decides, not the symlink source', async () => {
  const link = `${HOME}/.config/openchamber/current.json`;
  assert.equal(await managedConfigPath(link, async () => MANAGED, HOME), MANAGED);
  assert.equal(
    await managedConfigPath(MANAGED, async () => `${HOME}/.config/opencode/external.json`, HOME),
    null,
  );
  // A resolver failure falls back to the normalized path.
  assert.equal(await managedConfigPath(MANAGED, async () => { throw new Error('gone'); }, HOME), MANAGED);
});

test('registry files are parsed tolerantly', () => {
  assert.deepEqual(parseRegistryFile('123.json', '{"pid":123,"ownerPid":1}'), { pid: 123 });
  assert.equal(parseRegistryFile('123.json', '{oops'), null);
  assert.equal(parseRegistryFile('123.json', '{"pid":0}'), null);
  assert.equal(parseRegistryFile('123.json', '{"pid":"123"}'), null);
  assert.equal(parseRegistryFile('123.json', '{"pid":1}'), null);
  assert.equal(parseRegistryFile('not-a-pid.json', '{"pid":123}'), null);
});

test('the managed config can be recovered from a registered process environ', () => {
  assert.equal(
    managedConfigFromEnviron(`PATH=/usr/bin\0OPENCODE_CONFIG=${MANAGED}\0HOME=${HOME}`),
    MANAGED,
  );
  assert.equal(managedConfigFromEnviron(`OPENCODE_CONFIG=${HOME}/.config/opencode/external.json\0`), null);
  assert.equal(managedConfigFromEnviron(`OPENCODE_CONFIG=${MANAGED}-old\0`), null);
  assert.equal(managedConfigFromEnviron(null), null);
});

const candidate = (pid: number): RegistryCandidate => ({ pid });

test('only PIDs whose environ carries the exact OPENCODE_CONFIG token are picked', () => {
  const environs = new Map<number, string | null>([
    [10, `PATH=/usr/bin\0OPENCODE_CONFIG=${MANAGED}\0HOME=${HOME}`],
    [11, `OPENCODE_CONFIG=${MANAGED}-other\0`],
    [12, `OPENCODE_CONFIG=${HOME}/.config/opencode/other.json\0`],
    [13, null],
  ]);
  const pids = pickManagedPids(
    [candidate(10), candidate(11), candidate(12), candidate(13), candidate(10), candidate(0), candidate(1)],
    MANAGED,
    (pid) => environs.get(pid),
    999,
  );
  assert.deepEqual(pids, [10]);
});

test('the service itself is never a candidate, even with a matching environ', () => {
  const pids = pickManagedPids(
    [candidate(4242), candidate(4243)],
    MANAGED,
    () => `OPENCODE_CONFIG=${MANAGED}\0`,
    4242,
  );
  assert.deepEqual(pids, [4243]);
});
