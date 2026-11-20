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
import { parseCatalogOutput } from './model-audit.ts';
import { managedConfigFromEnviron, managedConfigPath, parseRegistryFile, pickManagedPids, type RegistryCandidate } from './service-restart.ts';

const PORT = Number(process.env.OPENCHAMBER_SERVICE_PORT ?? '0');
const TOKEN = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!PORT) throw new Error('OPENCHAMBER_SERVICE_PORT missing');
if (!TOKEN) throw new Error('OPENCHAMBER_SERVICE_TOKEN missing');

/** Catalog answers older than this make the next request re-run the CLI. */
const CACHE_MS = 60_000;
/** The CLI reaches its background service; give it time, but not forever. */
const CLI_TIMEOUT_MS = 20_000;
/** Exec candidates, in order: PATH first, then the well-known install path. */
const CLI_CANDIDATES = (): string[] => ([
  'opencode',
  path.join(homedir(), '.opencode', 'bin', 'opencode'),
]);

type Cache = { catalog: string[]; checkedAt: string; variants: Record<string, string[]>; error?: undefined } | null;
let cache: Cache = null;
let inflight: Promise<Exclude<Cache, null>> | null = null;

const runOnce = (cmd: string): Promise<string> => new Promise((resolve, reject) => {
  execFile(cmd, ['models'], { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    (error, stdout) => (error ? reject(error) : resolve(stdout)));
});

const fetchVariants = async (cmd: string): Promise<Record<string, string[]>> => {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(cmd, ['api', 'GET', '/api/model'], { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (error, out) => (error ? reject(error) : resolve(out)));
    });
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
  let lastError: unknown = null;
  for (const cmd of CLI_CANDIDATES()) {
    try {
      const stdout = await runOnce(cmd);
      const catalog = parseCatalogOutput(stdout);
      const variants = await fetchVariants(cmd);
      return { catalog, checkedAt: new Date().toISOString(), variants };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('opencode CLI not found');
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
    if (url.pathname === '/switch-model' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}') as { sessionId?: unknown; model?: unknown };
          const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
          const model = typeof parsed.model === 'string' ? parsed.model : '';
          if (!sessionId || !model) { send(res, 400, { ok: false, error: 'missing-args' }); return; }
          const slash = model.indexOf('/');
          if (slash <= 0) { send(res, 400, { ok: false, error: 'bad-model' }); return; }
          const providerID = model.slice(0, slash);
          const modelID = model.slice(slash + 1);
          const args = ['api', 'POST', `/api/session/${sessionId}/model`, '-d', JSON.stringify({ model: { id: modelID, providerID, modelID } })];
          await new Promise<void>((resolve, reject) => {
            execFile(CLI_CANDIDATES()[0], args, { timeout: CLI_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
              (error, _stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve()));
          });
          send(res, 200, { ok: true });
        } catch (error) {
          send(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      });
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
