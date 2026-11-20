import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVE_STALE_MS, buildSessionTree, emptyTurnStartTracker, groupActiveSessions, sameDirectory, trackTurnStarts, type AgentSession } from '../src/sessions.ts';

/** Test base time; relative timestamps keep the staleness cases exact. */
const NOW = Date.now();

const session = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 's1', title: 'Arbeit', projectId: 'p1', directory: '/project', parentId: 'parent',
  createdAt: 0, updatedAt: NOW, archivedAt: null, worktree: null,
  activity: 'running', outcome: null, items: [], agent: 'fixer', ...overrides,
});

test('groups only active, unarchived subagents in the current project and directory', () => {
  const grouped = groupActiveSessions([
    session(), session({ id: 's2', activity: 'retrying' }),
    session({ id: 's3', activity: 'waiting-permission' }),
    session({ id: 's4', activity: 'waiting-question', agent: 'designer' }),
    session({ id: 'parent', parentId: null }), session({ id: 'archived', archivedAt: 1 }),
    session({ id: 'other-dir', directory: '/other' }), session({ id: 'other-project', projectId: 'p2' }),
    session({ id: 'no-agent', agent: undefined }),
  ], 'p1', '/project');
  assert.deepEqual([...grouped].map(([agent, entries]) => [agent, entries.map((entry) => entry.id)]), [
    ['fixer', ['s1', 's2', 's3']], ['designer', ['s4']],
  ]);
});

test('active sessions without an agent produce no groups', () => {
  const grouped = groupActiveSessions([
    session({ id: 'missing', agent: undefined }),
    session({ id: 'empty', agent: '' }),
    session({ id: 'blank', agent: '  ', activity: 'waiting-question' }),
  ], 'p1', '/project');
  assert.equal(grouped.size, 0);
});

test('keeps named groups when unattributed sessions are present', () => {
  const grouped = groupActiveSessions([
    session({ id: 'missing', agent: undefined }),
    session({ id: 'named', agent: 'Subagenten' }),
    session({ id: 'fixer' }),
  ], 'p1', '/project');
  assert.equal(grouped.size, 2);
  assert.deepEqual(grouped.get('Subagenten')?.map((item) => item.id), ['named']);
  assert.deepEqual(grouped.get('fixer')?.map((item) => item.id), ['fixer']);
});

test('no active subagents produces no groups', () => {
  const grouped = groupActiveSessions([
    session({ activity: 'idle', outcome: 'completed' }),
    session({ activity: 'unknown', outcome: 'completed' }),
    session({ archivedAt: 5 }),
    session({ parentId: null }),
  ], 'p1', '/project');
  assert.equal(grouped.size, 0);
});

test('an active status older than its grace counts as a leftover of a hard shutdown', () => {
  // Frozen after a power cut: last status 'unknown', never cleared again.
  const grouped = groupActiveSessions([
    session({ id: 'unknown-ghost', activity: 'unknown', updatedAt: NOW - ACTIVE_STALE_MS.unknown - 1 }),
    session({ id: 'running-ghost', activity: 'running', updatedAt: NOW - ACTIVE_STALE_MS.running - 1 }),
    session({ id: 'permission-ghost', activity: 'waiting-permission', updatedAt: NOW - ACTIVE_STALE_MS['waiting-permission'] - 1 }),
    session({ id: 'still-fresh', activity: 'unknown', updatedAt: NOW - ACTIVE_STALE_MS.unknown + 60_000 }),
    session({ id: 'long-call', activity: 'running', updatedAt: NOW - ACTIVE_STALE_MS.running + 60_000 }),
  ], 'p1', '/project', null, NOW);
  assert.deepEqual(grouped.get('fixer')?.map((entry) => entry.id), ['still-fresh', 'long-call']);
});

// Drive the counts through explicit times: inside the grace the session stays
// active, after it the same snapshot regroups it into the finished window.
test('a session crosses from active to recent when its grace expires', () => {
  const updatedAt = NOW - ACTIVE_STALE_MS.unknown + 30_000;
  const active = groupActiveSessions([session({ activity: 'unknown', updatedAt })], 'p1', '/project', null, NOW);
  assert.deepEqual(active.get('fixer')?.map((entry) => entry.id), ['s1']);
  const later = NOW + ACTIVE_STALE_MS.unknown + 10_000;
  const after = groupActiveSessions([session({ activity: 'unknown', updatedAt })], 'p1', '/project', null, later);
  assert.equal(after.get('fixer'), undefined);
});

const current = { id: 'root', title: 'Aktuell', busy: false, agent: 'fixer', model: 'model/id' };

test('turn anchors are unknown on the first snapshot, because the turn predates observation', () => {
  const tracker = trackTurnStarts(emptyTurnStartTracker(), [session({ activity: 'running' })], NOW);
  assert.equal(tracker.observed, true);
  assert.equal(tracker.starts.get('s1'), null);
  // A later running snapshot must not invent a start for that same turn.
  const later = trackTurnStarts(
    tracker, [session({ activity: 'running', updatedAt: NOW + 10_000 })], NOW + 10_000,
  );
  assert.equal(later.starts.get('s1'), null);
});

test('a turn that starts between snapshots gets an anchor that survives while it runs', () => {
  let tracker = trackTurnStarts(emptyTurnStartTracker(), [session({ activity: 'unknown' })], NOW);
  assert.equal(tracker.starts.size, 0);
  const startedAt = NOW + 5_000;
  tracker = trackTurnStarts(tracker, [session({ activity: 'running', updatedAt: startedAt })], startedAt);
  assert.equal(tracker.starts.get('s1'), startedAt);
  // Retrying belongs to the same busy state and keeps the anchor.
  tracker = trackTurnStarts(
    tracker, [session({ activity: 'retrying', updatedAt: startedAt + 3_000 })], startedAt + 3_000,
  );
  assert.equal(tracker.starts.get('s1'), startedAt);
});

test('a pause or result drops the anchor; the next turn anchors anew', () => {
  const startedAt = NOW + 5_000;
  let tracker = trackTurnStarts(emptyTurnStartTracker(), [], NOW);
  tracker = trackTurnStarts(tracker, [session({ activity: 'running', updatedAt: startedAt })], startedAt);
  assert.equal(tracker.starts.get('s1'), startedAt);
  const waiting = trackTurnStarts(
    tracker, [session({ activity: 'waiting-permission', updatedAt: startedAt + 2_000 })], startedAt + 2_000,
  );
  assert.equal(waiting.starts.has('s1'), false);
  const restartedAt = startedAt + 9_000;
  const restarted = trackTurnStarts(
    waiting, [session({ activity: 'running', updatedAt: restartedAt })], restartedAt,
  );
  assert.equal(restarted.starts.get('s1'), restartedAt);
});

test('finished, stale and vanished sessions hold no turn anchor', () => {
  let tracker = trackTurnStarts(emptyTurnStartTracker(), [], NOW);
  tracker = trackTurnStarts(tracker, [session({ activity: 'running' })], NOW);
  assert.equal(tracker.starts.size, 1);
  const stale = trackTurnStarts(
    tracker, [session({ activity: 'running', updatedAt: NOW - ACTIVE_STALE_MS.running - 1 })], NOW,
  );
  assert.equal(stale.starts.size, 0);
  const finished = trackTurnStarts(
    tracker, [session({ activity: 'idle', outcome: 'completed', updatedAt: NOW })], NOW,
  );
  assert.equal(finished.starts.size, 0);
  const gone = trackTurnStarts(tracker, [], NOW);
  assert.equal(gone.starts.size, 0);
});

test('builds a tree rooted at the current session, including nested descendants', () => {
  const tree = buildSessionTree(current, [
    session({ id: 'root', title: 'Workspace-Titel', parentId: null }),
    session({ id: 'child', title: 'Kind', parentId: 'root', agent: undefined }),
    session({ id: 'grandchild', title: 'Enkel', parentId: 'child', directory: '/worktree', agent: undefined }),
    session({ id: 'sibling', title: 'Zweites Kind', parentId: 'root' }),
  ]);
  assert.equal(tree?.title, 'Aktuell');
  assert.deepEqual(tree?.children.map((node) => node.id), ['child', 'sibling']);
  assert.deepEqual(tree?.children[0].children.map((node) => node.id), ['grandchild']);
  assert.deepEqual(tree?.children[0].children[0].children, []);
});

test('excludes orphans and archived sessions with their descendants', () => {
  const tree = buildSessionTree(current, [
    session({ id: 'visible', parentId: 'root' }),
    session({ id: 'orphan', parentId: 'outside' }),
    session({ id: 'archived', parentId: 'root', archivedAt: 123 }),
    session({ id: 'archived-child', parentId: 'archived' }),
    session({ id: 'cycle', parentId: 'cycle' }),
  ]);
  assert.deepEqual(tree?.children.map((node) => node.id), ['visible']);
  assert.equal(buildSessionTree(current, [session({ id: 'root', archivedAt: 1 })]), null);
});

test('no current session is empty; a missing workspace root still shows available children', () => {
  const records = [session({ id: 'child', parentId: 'root' })];
  assert.equal(buildSessionTree(null, records), null);
  const tree = buildSessionTree(current, records);
  assert.equal(tree?.record, null);
  assert.deepEqual(tree?.children.map((node) => node.id), ['child']);
});

test('compares paths without confusing Windows case and POSIX case', () => {
  assert.equal(sameDirectory('C:\\Work\\Project\\', 'c:/work/project'), true);
  assert.equal(sameDirectory('C:\\', 'c:/'), true);
  assert.equal(sameDirectory('/Work/Project/', '/work/project'), false);
  assert.equal(sameDirectory('/', '/'), true);
});
