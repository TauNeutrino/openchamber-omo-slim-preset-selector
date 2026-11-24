/**
 * OpenCode host detection and the session switch target. Pure helpers shared
 * by the panel and the local service, so both agree on what "v2" means.
 *
 * OpenCode v2 reloads plugin config live: oh-my-opencode-slim picks up a new
 * preset for subagents without a restart, and `POST /api/location/reload`
 * rebuilds the agent list (and with it the orchestrator's default model).
 * OpenCode v1 has neither, so it keeps the restart prompt.
 */

// Types only: the service bundles this file, and config.ts pulls in
// jsonc-parser, whose UMD build breaks the service's ESM bundle at startup.
import type { PresetAgent } from './config.ts';

/** Same rules as config.ts primaryModel / primaryVariant (agent-level variant wins). */
const primaryModel = (agent: PresetAgent): string | null => agent.models[0]?.model ?? null;
const primaryVariant = (agent: PresetAgent): string => agent.variant ?? agent.models[0]?.variant ?? '';

/** Where OpenChamber's sessions run: its own managed server, or the shared background service. */
export type OpenCodeServerMode = 'managed' | 'shared' | 'unknown';

export type OpenCodeInfo = {
  version: string | null;
  major: number | null;
  server: OpenCodeServerMode;
};

/** The first `x.y.z` in `opencode --version` output, or null when none is there. */
export const parseOpenCodeVersion = (stdout: string): { version: string; major: number } | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!match) return null;
  return { version: `${match[1]}.${match[2]}.${match[3]}`, major: Number(match[1]) };
};

/** v2 and later reload config live; anything unknown keeps the v1 restart flow. */
export const supportsLiveReload = (info: Pick<OpenCodeInfo, 'major'> | null | undefined): boolean => (
  typeof info?.major === 'number' && info.major >= 2
);

/** `provider/model` split at the first slash; model ids may contain more slashes. */
export const splitModelRef = (ref: string): { providerID: string; id: string } | null => {
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return null;
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1) };
};

export type SessionTarget = {
  agent: 'orchestrator';
  providerID: string;
  id: string;
  variant?: string;
};

/** The orchestrator's primary model and effort in a preset, or null when it sets none. */
export const orchestratorTarget = (agents: readonly PresetAgent[] | undefined): SessionTarget | null => {
  const orchestrator = agents?.find((agent) => agent.agent === 'orchestrator');
  if (!orchestrator) return null;
  const ref = primaryModel(orchestrator);
  const split = ref ? splitModelRef(ref) : null;
  if (!split) return null;
  const variant = primaryVariant(orchestrator);
  return { agent: 'orchestrator', ...split, ...(variant ? { variant } : {}) };
};

/** `provider/model (variant)` for notices. */
export const targetLabel = (target: SessionTarget): string => (
  `${target.providerID}/${target.id}${target.variant ? ` (${target.variant})` : ''}`
);

/** Body for OpenCode v2 `POST /api/session/{id}/model` (session.switchModel). */
export const switchModelBody = (target: Pick<SessionTarget, 'providerID' | 'id' | 'variant'>): string => JSON.stringify({
  model: { id: target.id, providerID: target.providerID, ...(target.variant ? { variant: target.variant } : {}) },
});

/** OpenCode session ids; anything else never reaches a CLI path argument. */
export const isSessionId = (value: unknown): value is string => (
  typeof value === 'string' && /^ses_[A-Za-z0-9]{8,64}$/.test(value)
);
