/**
 * Omo Preset local service: answers the panel's model-catalog checks by asking
 * the OpenCode CLI for the effective model list. Nothing here reads secrets:
 * the host copies only PATH, HOME and locale into this process, and auth data
 * stays with OpenCode itself.
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseCatalogOutput } from './model-audit.ts';
import { isSessionId, parseOpenCodeVersion, splitModelRef, switchModelBody, type OpenCodeInfo } from './opencode-mode.ts';
import { managedConfigFromEnviron, managedConfigPath, parseRegistryFile, pickManagedPids, type RegistryCandidate } from './service-restart.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '0');
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!PORT) throw new Error('OPENCHAMBER_SERVICE_PORT missing');
if (!TOKEN) throw new Error('OPENCHAMBER_SERVICE_TOKEN missing');

/** Catalog answers older than this make the next request re-run the CLI. */
const CACHE_MS = 60_000;
/** The CLI reaches its background service; give it time, but not forever. */
const CLI_TIMEOUT_MS = 20_000;
/** location.reload answers once every location is rebuilt; that can take a while. */
const RELOAD_TIMEOUT_MS = 90_000;

/**
 * Native binaries behind npm's Windows shims. execFile cannot run the
 * `opencode.cmd` / `opencode.ps1` shims npm puts on PATH (ENOENT without a
 * shell), so look for the real executable next to them.
 */
const windowsShimTargets = (): string[] => {
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    if (existsSync(path.join(dir, 'opencode.exe'))) out.push(path.join(dir, 'opencode.exe'));
    if (!existsSync(path.join(dir, 'opencode.cmd'))) continue;
    for (const pkg of [['@opencode', 'cli'], ['opencode-ai']]) {
      const exe = path.join(dir, 'node_modules', ...pkg, 'bin', 'opencode.exe');
      if (existsSync(exe)) out.push(exe);
    }
  }
  return out;
};

const readOpenChamberSettings = (): Record<string, unknown> => {
  try {
    const raw = readFileSync(path.join(homedir(), '.config', 'openchamber', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};

/** OpenChamber's own choice of binary, when the setting points at a file that exists. */
const openChamberBinary = (): string | null => {
  const value = readOpenChamberSettings().opencodeBinary;
  return typeof value === 'string' && value.trim() && existsSync(value) ? value : null;
};

/**
 * OpenChamber desktop's local server. It forwards `/api/...` to the OpenCode
 * server its sessions run on, with that server's credentials. Calls made here
 * run inside that server, so their events (session.model.selected,
 * session.agent.selected) reach the open window and its model picker; calls
 * made through the CLI land in the shared background service, whose events
 * the window never sees. Checked through /health so a stale port is ignored.
 */
let openChamberBaseCache: { base: string | null; at: number } | null = null;
const openChamberBase = async (): Promise<string | null> => {
  if (openChamberBaseCache && Date.now() - openChamberBaseCache.at < 30_000) return openChamberBaseCache.base;
  let base: string | null = null;
  const port = Number(readOpenChamberSettings().desktopLocalPort);
  if (Number.isInteger(port) && port > 0 && port < 65536) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      const health = await response.json() as { status?: unknown; openchamberVersion?: unknown };
      if (response.ok && health.status === 'ok' && typeof health.openchamberVersion === 'string') {
        base = `http://127.0.0.1:${port}`;
      }
    } catch {
      base = null;
    }
  }
  openChamberBaseCache = { base, at: Date.now() };
  return base;
};

/** OpenCode API call through OpenChamber's server; throws with the server's message on failure. */
const viaOpenChamber = async (base: string, method: 'GET' | 'POST', apiPath: string, body?: unknown, timeout = CLI_TIMEOUT_MS): Promise<void> => {
  const response = await fetch(`${base}${apiPath}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`OpenChamber ${method} ${apiPath}: HTTP ${response.status}${text ? ` ${text}` : ''}`);
  }
};

/** Exec candidates, in order: OpenChamber's binary, PATH, then the well-known install path. */
const CLI_CANDIDATES = (): string[] => {
  const home = path.join(homedir(), '.opencode', 'bin', 'opencode');
  const list = [
    openChamberBinary(),
    ...(process.platform === 'win32' ? windowsShimTargets() : []),
    'opencode',
    home,
    ...(process.platform === 'win32' ? [`${home}.exe`] : []),
  ].filter((entry): entry is string => typeof entry === 'string');
  return [...new Set(list)];
};

/** Runs the first CLI candidate that starts; a missing candidate falls through to the next. */
const runCli = async (args: string[], timeout: number = CLI_TIMEOUT_MS): Promise<string> => {
  let lastError: unknown = null;
  for (const cmd of CLI_CANDIDATES()) {
    try {
      return await new Promise<string>((resolve, reject) => {
        execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (!error) {
            resolve(stdout);
            return;
          }
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
          const detail = String(stderr || '').trim() || String(stdout || '').trim() || error.message;
          reject(Object.assign(new Error(missing ? 'ENOENT' : detail), { missing }));
        });
      });
    } catch (error) {
      lastError = error;
      if (!(error as { missing?: boolean }).missing) throw error;
    }
  }
  throw lastError ?? new Error('opencode CLI not found');
};

type Cache = { catalog: string[]; checkedAt: string; variants: Record<string, string[]>; error?: undefined } | null;
let cache: Cache = null;
let inflight: Promise<Exclude<Cache, null>> | null = null;

const fetchVariants = async (): Promise<Record<string, string[]>> => {
  try {
    const stdout = await runCli(['api', 'GET', '/api/model']);
    const parsed = JSON.parse(stdout) as { data?: unknown };
    const data = Array.isArray(parsed?.data) ? parsed.data : [];
    const out: Record<string, string[]> = {};
    for (const entry of data) {
      if (typeof entry !== 'object' || entry === null) continue;
      const providerID = (entry as { providerID?: unknown }).providerID;
      const modelID = (entry as { modelID?: unknown }).modelID;
      const variants = (entry as { variants?: unknown }).variants;
      if (typeof providerID !== 'string' || typeof modelID !== 'string') continue;
      const ids = Array.isArray(variants)
        ? variants.map((v) => (typeof v === 'object' && v !== null ? (v as { id?: unknown }).id : null)).filter((x): x is string => typeof x === 'string')
        : [];
      if (ids.length) out[`${providerID}/${modelID}`] = ids;
    }
    return out;
  } catch {
    return {};
  }
};

const refreshCatalog = async (): Promise<Exclude<Cache, null>> => {
  const catalog = parseCatalogOutput(await runCli(['models']));
  const variants = await fetchVariants();
  return { catalog, checkedAt: new Date().toISOString(), variants };
};

const getCatalog = async (force: boolean): Promise<Exclude<Cache, null>> => {
  if (!force && cache && Date.now() - Date.parse(cache.checkedAt) < CACHE_MS) return cache;
  if (inflight) return inflight;
  inflight = refreshCatalog()
    .then((value) => { cache = value; return value; })
    .finally(() => { inflight = null; });
  return inflight;
};

const send = (res: http.ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(payload);
};

/** OpenChamber keeps one registry file per managed OpenCode process. */
const REGISTRY_DIR = path.join(homedir(), '.config', 'openchamber', 'managed-opencode');
/** Reading the whole environment is unnecessary; 256 KiB covers realistic setups. */
const ENVIRON_LIMIT_BYTES = 256 * 1024;

/**
 * Reads the registry: one `<pid>.json` per managed process. Unreadable or
 * corrupt files are skipped instead of failing the whole restart.
 */
const readRegistryEntries = async (): Promise<RegistryCandidate[]> => {
  let names: string[];
  try {
    names = await fsp.readdir(REGISTRY_DIR);
  } catch {
    return [];
  }
  const entries: RegistryCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const content = await fsp.readFile(path.join(REGISTRY_DIR, name), 'utf8');
      const entry = parseRegistryFile(name, content);
      if (entry) entries.push(entry);
    } catch {
      // Process vanished or file is corrupt; that candidate simply drops out.
    }
  }
  return entries;
};

/**
 * The process environment, but only for a live process of this uid. The
 * managed flag lives in OPENCODE_CONFIG (not argv), so this is the identity
 * check that keeps a same-named external service from being killed.
 */
const readManagedEnviron = async (pid: number): Promise<string | null> => {
  const base = `/proc/${pid}`;
  try {
    const info = await fsp.stat(base);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid !== null && info.uid !== uid) return null;
    const handle = await fsp.open(path.join(base, 'environ'), 'r');
    try {
      const buffer = Buffer.alloc(ENVIRON_LIMIT_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, ENVIRON_LIMIT_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
};

/**
 * SIGTERM the managed OpenCode process; OpenChamber's health check restarts it.
 * No match is success: the process may already be restarting.
 */
const restartManagedOpenCode = async (res: http.ServerResponse): Promise<void> => {
  let managedPath = await managedConfigPath(process.env.OPENCODE_CONFIG, fsp.realpath);
  const entries = await readRegistryEntries();
  const environs = new Map<number, string | null>();
  for (const entry of entries) environs.set(entry.pid, await readManagedEnviron(entry.pid));
  // The host does not forward OPENCODE_CONFIG to contributed services on every
  // installation. The registry entry's own environ still proves the process is
  // managed; the strict run/instances/<id> pattern remains the gate.
  if (!managedPath) {
    for (const environ of environs.values()) {
      const candidate = managedConfigFromEnviron(environ);
      if (!candidate) continue;
      managedPath = await managedConfigPath(candidate, fsp.realpath);
      if (managedPath) break;
    }
  }
  if (!managedPath) {
    send(res, 409, { ok: false, error: 'external' });
    return;
  }
  const pids = pickManagedPids(entries, managedPath, (pid) => environs.get(pid));
  const killed: number[] = [];
  try {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch (error) {
        // The process already exited between the check and the signal.
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        throw error;
      }
    }
  } catch (error) {
    send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }
  send(res, 200, { ok: true, killed });
};

/** A live OpenChamber-managed OpenCode process means sessions do not run on the shared service. */
const detectServerMode = async (): Promise<OpenCodeInfo['server']> => {
  const entries = await readRegistryEntries();
  for (const entry of entries) {
    if (entry.pid === process.pid) continue;
    try {
      process.kill(entry.pid, 0);
      return 'managed';
    } catch (error) {
      // EPERM: alive but owned by another user; still a managed server.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return 'managed';
    }
  }
  return 'shared';
};

const INFO_CACHE_MS = 30_000;
let infoCache: { info: OpenCodeInfo; at: number } | null = null;

const getOpenCodeInfo = async (force = false): Promise<OpenCodeInfo> => {
  if (!force && infoCache && Date.now() - infoCache.at < INFO_CACHE_MS) return infoCache.info;
  let parsed: { version: string; major: number } | null = null;
  try {
    parsed = parseOpenCodeVersion(await runCli(['--version'], 10_000));
  } catch {
    parsed = null;
  }
  const info: OpenCodeInfo = {
    version: parsed?.version ?? null,
    major: parsed?.major ?? null,
    server: await detectServerMode().catch(() => 'unknown' as const),
  };
  infoCache = { info, at: Date.now() };
  return info;
};

const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
    if (body.length > 64 * 1024) reject(new Error('body-too-large'));
  });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}') as unknown;
      resolve(typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {});
    } catch (error) {
      reject(error);
    }
  });
  req.on('error', reject);
});

/**
 * Rebuilds OpenCode's locations so the agent list (and with it the
 * orchestrator's default model) follows the new preset. OpenChamber's server
 * reaches whichever OpenCode server its sessions use; without it only the
 * shared background service is reachable (CLI credentials), and a managed
 * server with its per-launch password answers `reloaded: false`.
 */
const reloadConfig = async (res: http.ServerResponse): Promise<void> => {
  const info = await getOpenCodeInfo(true);
  if (!(typeof info.major === 'number' && info.major >= 2)) {
    send(res, 409, { ok: false, error: 'not-v2', info });
    return;
  }
  const base = await openChamberBase();
  if (base) {
    await viaOpenChamber(base, 'POST', '/api/location/reload', undefined, RELOAD_TIMEOUT_MS);
    send(res, 200, { ok: true, reloaded: true, via: 'openchamber', info });
    return;
  }
  if (info.server === 'managed') {
    send(res, 200, { ok: true, reloaded: false, reason: 'managed', info });
    return;
  }
  await runCli(['api', 'POST', '/api/location/reload'], RELOAD_TIMEOUT_MS);
  send(res, 200, { ok: true, reloaded: true, info });
};

/**
 * Puts a session on an agent, model and effort, the same state OpenChamber's
 * model picker reads. OpenCode v2 servers share the session store, so the CLI's
 * background service can write it for a session that runs elsewhere.
 */
const switchSession = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
  const body = await readBody(req);
  const sessionId = body.sessionId;
  const agent = typeof body.agent === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.agent) ? body.agent : null;
  const model = typeof body.model === 'string' ? splitModelRef(body.model) : null;
  const variant = typeof body.variant === 'string' && body.variant.trim() ? body.variant.trim() : undefined;
  if (!isSessionId(sessionId) || !model) {
    send(res, 400, { ok: false, error: 'missing-args' });
    return;
  }
  const modelBody = switchModelBody({ ...model, variant });
  // Agent first: switching the agent may reset the model to that agent's default.
  const base = await openChamberBase();
  if (base) {
    if (agent) await viaOpenChamber(base, 'POST', `/api/session/${sessionId}/agent`, { agent });
    await viaOpenChamber(base, 'POST', `/api/session/${sessionId}/model`, JSON.parse(modelBody));
    send(res, 200, { ok: true, via: 'openchamber' });
    return;
  }
  // Fallback: the shared background service. The session changes, but an
  // OpenChamber window attached to a different server only shows it after a refresh.
  if (agent) await runCli(['api', 'POST', `/api/session/${sessionId}/agent`, '-d', JSON.stringify({ agent })]);
  await runCli(['api', 'POST', `/api/session/${sessionId}/model`, '-d', modelBody]);
  send(res, 200, { ok: true, via: 'cli' });
};

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method-not-allowed' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    send(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  try {
    // The host polls GET /health to decide the service has become ready.
    if (url.pathname === '/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname === '/models') {
      const force = url.searchParams.get('refresh') === 'true';
      const { catalog, checkedAt, variants } = await getCatalog(force);
      send(res, 200, { ok: true, catalog, checkedAt, variants, source: 'opencode models' });
      return;
    }
    if (url.pathname === '/restart-opencode' && req.method === 'POST') {
      await restartManagedOpenCode(res);
      return;
    }
    if (url.pathname === '/opencode-info') {
      send(res, 200, { ok: true, ...(await getOpenCodeInfo(url.searchParams.get('refresh') === 'true')) });
      return;
    }
    if (url.pathname === '/reload-config' && req.method === 'POST') {
      await reloadConfig(res);
      return;
    }
    // /switch-model is the older confirm flow's route; it shares the handler,
    // which sends the body session.switchModel accepts (id, providerID, variant).
    if ((url.pathname === '/switch-session' || url.pathname === '/switch-model') && req.method === 'POST') {
      await switchSession(req, res);
      return;
    }
    send(res, 404, { ok: false, error: 'not-found' });
  } catch (error) {
    send(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  process.send?.({ readiness: 'listening' });
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000).unref();
  });
}
