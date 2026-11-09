/**
 * Omo Preset local service: answers the panel's model-catalog checks by asking
 * the OpenCode CLI for the effective model list. Nothing here reads secrets:
 * the host copies only PATH, HOME and locale into this process, and auth data
 * stays with OpenCode itself.
 */

import http from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseCatalogOutput } from './model-audit.ts';
import { abortArgs, buildStopRecord, stopFilePath } from './stop.ts';

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

/**
 * Aborts the given sessions and drops the plugin's stop record for the project,
 * so the orchestrator's next turn carries the emergency-stop notice. Each abort
 * is best effort: a session that already finished is not an error worth
 * reporting to the panel.
 */
const killSessions = async (sessionIds: string[], parents: string[], directory: string): Promise<{
  aborted: number;
  failed: number;
  stopPath: string;
}> => {
  const cmd = CLI_CANDIDATES()[0];
  const abortOne = (sessionId: string): Promise<boolean> => new Promise((resolve) => {
    execFile(cmd, abortArgs(sessionId), { timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error) => resolve(!error));
  });
  const results = await Promise.all(sessionIds.map(abortOne));

  const dataHome = process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share');
  const stopPath = stopFilePath(dataHome, directory);
  const record = buildStopRecord(parents, Date.now());
  fs.mkdirSync(path.dirname(stopPath), { recursive: true });
  const tmp = `${stopPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record));
    fs.renameSync(tmp, stopPath);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed */ }
  }

  return {
    aborted: results.filter(Boolean).length,
    failed: results.filter((ok) => !ok).length,
    stopPath,
  };
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
    if (url.pathname === '/kill-sessions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}') as { sessionIds?: unknown; parents?: unknown; directory?: unknown };
          const ids = Array.isArray(parsed.sessionIds)
            ? parsed.sessionIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];
          const parents = Array.isArray(parsed.parents)
            ? parsed.parents.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
            : [];
          const directory = typeof parsed.directory === 'string' ? parsed.directory.trim() : '';
          if (ids.length === 0 || !directory || !path.isAbsolute(directory)) {
            send(res, 400, { ok: false, error: 'missing-args' });
            return;
          }
          const result = await killSessions(ids, parents, directory);
          send(res, 200, { ok: true, ...result });
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
