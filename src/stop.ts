/**
 * Emergency-stop plumbing shared by the service and its tests.
 *
 * oh-my-opencode-slim's `/killall` does two things: it aborts the running
 * subagent sessions, and it drops a `kill-all-stop.json` next to the TUI state
 * so the orchestrator's next turn carries the stop notice. Both live under the
 * OpenCode data directory, scoped per project with the first 12 hex characters
 * of sha256(resolved project directory) — the plugin's own `projectScope()`.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

/** The plugin's per-project storage directory name. */
export const projectScopeHash = (directory: string): string => (
  createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 12)
);

/** `~/.local/share/opencode/storage/oh-my-opencode-slim/<scope>/kill-all-stop.json` */
export const stopFilePath = (dataHome: string, directory: string): string => (
  path.join(dataHome, 'opencode', 'storage', 'oh-my-opencode-slim', projectScopeHash(directory), 'kill-all-stop.json')
);

export type StopRecord = { at: number; parents: string[] };

/** The record the plugin's reader accepts: a timestamp and the parent sessions. */
export const buildStopRecord = (parents: readonly string[], at: number): StopRecord => ({
  at,
  parents: [...new Set(parents.filter((id) => typeof id === 'string' && id.trim() !== ''))],
});

/** Arguments for `opencode api POST /api/session/<id>/abort`. */
export const abortArgs = (sessionId: string): string[] => (
  ['api', 'POST', `/api/session/${sessionId}/abort`]
);
