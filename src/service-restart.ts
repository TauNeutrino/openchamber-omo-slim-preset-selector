/**
 * Pure helpers for POST /restart-opencode. The service wrapper owns the actual
 * filesystem and /proc access; these functions only decide which paths and PIDs
 * are allowed, so the rules stay testable without starting the HTTP server.
 */
import path from 'node:path';
import { homedir } from 'node:os';

/** OpenChamber's managed config lives under run/instances/<id>/. */
const MANAGED_CONFIG_RE = /(?:^|[\\/])run[\\/]instances[\\/]\d+[\\/]opencode\.managed\.json$/;

const expandHome = (raw: string, home: string): string => {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(home, raw.slice(2));
  return raw;
};

/**
 * The absolute, realpath-resolved managed config path, or null when
 * OPENCODE_CONFIG points anywhere else (an external OpenCode process).
 */
export const managedConfigPath = async (
  raw: string | undefined,
  realpath: (value: string) => Promise<string> = async (value) => value,
  home: string = homedir(),
): Promise<string | null> => {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const absolute = path.resolve(expandHome(trimmed, home));
  let resolved = absolute;
  try {
    resolved = await realpath(absolute);
  } catch {
    // A missing path cannot be the running managed config; keep the normalized
    // form so the pattern check still decides.
  }
  return MANAGED_CONFIG_RE.test(resolved) ? resolved : null;
};

export type RegistryCandidate = { pid: number };

/** The managed config path from a NUL-separated environ, or null. */
export const managedConfigFromEnviron = (environ: string | null | undefined): string | null => {
  if (!environ) return null;
  for (const token of environ.split('\0')) {
    if (!token.startsWith('OPENCODE_CONFIG=')) continue;
    const value = token.slice('OPENCODE_CONFIG='.length);
    if (MANAGED_CONFIG_RE.test(path.normalize(value))) return value;
  }
  return null;
};

/** One `managed-opencode/<pid>.json`; corrupt or implausible entries are skipped. */
export const parseRegistryFile = (name: string, content: string): RegistryCandidate | null => {
  if (!/^\d+\.json$/.test(name)) return null;
  try {
    const parsed = JSON.parse(content) as { pid?: unknown };
    const pid = parsed?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return null;
    return { pid };
  } catch {
    return null;
  }
};

/**
 * Keeps only PIDs whose environment carries exactly this OPENCODE_CONFIG token.
 * `readEnviron` returns the NUL-separated environ (or null when unreadable, the
 * process is gone, or it belongs to another uid). The service's own PID is never
 * a candidate, and duplicates collapse to one kill.
 */
export const pickManagedPids = (
  entries: readonly RegistryCandidate[],
  managedPath: string,
  readEnviron: (pid: number) => string | null | undefined,
  selfPid: number = process.pid,
): number[] => {
  const token = `OPENCODE_CONFIG=${managedPath}`;
  const pids: number[] = [];
  for (const entry of entries) {
    const pid = entry.pid;
    if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) continue;
    const environ = readEnviron(pid);
    if (!environ) continue;
    if (!environ.split('\0').includes(token)) continue;
    if (!pids.includes(pid)) pids.push(pid);
  }
  return pids;
};
