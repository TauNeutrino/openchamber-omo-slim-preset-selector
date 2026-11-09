/**
 * Dev-only preview for the agent list. It copies the <style> block out of
 * panel/index.html and renders the same markup agentRow() produces, with the
 * real akita preset data, at several panel widths — so a CSS/layout change can
 * be judged without the OpenChamber host.
 *
 *   node scripts/preview-agents.mjs && open preview/agents.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const style = panel.slice(panel.indexOf('<style>') + 7, panel.indexOf('</style>'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** agentRow() markup: one row per agent, chains as +N, optional sessions. */
const row = ({ name, provider, id, fallbacks = 0, variant = '', sessions = null, recent = 0, missing = false, inherited = '', open = false }) => {
  const pills = [
    fallbacks ? `<span class="variant fallback-count" title="${fallbacks} fallback models">+${fallbacks}</span>` : '',
    variant ? `<span class="variant"><span class="model-content">${variant}</span></span>` : '',
    inherited && provider ? `<span class="variant" title="inherits from ${inherited}">⇢ ${inherited}</span>` : '',
  ].filter(Boolean).join('');
  const pillWrapper = pills ? `<span class="agent-pills">${pills}</span>` : '';
  const primary = provider ? `${provider}${id}` : (inherited ? `inherits from ${inherited}` : 'no model set');
  const chain = [primary, variant ? `(${variant})` : ''].filter(Boolean).join(' ')
    + (fallbacks ? ` → +${fallbacks} fallback${fallbacks > 1 ? 's' : ''}` : '');
  const title = `${name} · ${chain}${missing ? ' — model not found in catalog' : ''}`;
  const content = provider
    ? `<span class="model-content">${id}</span>`
    : `<span class="model-content is-inherited">${inherited ? `inherits from ${inherited}` : 'no model set'}</span>`;
  const model = `<span class="model-text">${content}</span>`;
  const label = sessions
    ? `<button class="agent-disclosure" aria-expanded="${open}">${sessions ? `<span class="session-count">${sessions}</span>` : ''}${recent ? `<span class="session-count is-done">${recent}</span>` : ''}<span class="agent-name">${name}</span><span class="agent-chevron">${open ? '▴' : '▾'}</span></button>`
    : `<span class="agent-name">${name}</span>`;
  const list = open
    ? `<div class="session-list" aria-label="${name}: active and recent sessions"><div class="session-option"><button class="session-open"><span class="session-title">Refactor the auth middleware</span><span class="session-activity is-live">1m 12s</span></button></div><div class="session-option is-done"><button class="session-open"><span class="session-title">Fix flaky login test</span><span class="session-activity">✓ 12 min ago</span></button><button class="session-hide"><span class="session-hide-glyph">👁</span></button></div></div>`
    : '';
  return `<div class="agent-group${missing ? ' is-missing' : ''}"><div class="agent">${label}<span class="agent-model is-editable" title="${title}">${model}${pillWrapper}</span></div>${list}</div>`;
};

const AKITA = [
  { name: 'orchestrator', provider: 'opencode-go/', id: 'deepseek-v4.1-flash', fallbacks: 2, sessions: '①', recent: 1, open: true },
  { name: 'oracle', provider: 'magpie/agy-cli/', id: 'gemini-4-argon', fallbacks: 3, variant: 'high' },
  { name: 'explorer', provider: 'opencode-go/', id: 'deepseek-v4.1-flash', fallbacks: 1 },
  { name: 'designer', provider: 'opencode-go/', id: 'kimi-k2.7-code', fallbacks: 1 },
  { name: 'fixer', provider: 'opencode-go/', id: 'deepseek-v4.1-flash', fallbacks: 1 },
  { name: 'observer', provider: 'opencode-go/', id: 'mimo-v2.5' },
  { name: 'validator', provider: 'opencode-go/', id: 'deepseek-v4.1-flash', fallbacks: 1 },
  { name: 'paladin', provider: 'opencode-go/', id: 'gemini-4-argon', fallbacks: 1 },
  { name: 'hunter', provider: 'opencode-go/', id: 'mimo-v2.6-flash', fallbacks: 1 },
  { name: 'proctor', provider: 'opencode-go/', id: 'deepseek-v4.1-flash', fallbacks: 1 },
];

// Edge cases the real config can produce, shown in a second list.
const EDGES = [
  { name: 'orchestrator', provider: 'openrouter/stealth/', id: 'crouton-alpha', fallbacks: 1 },
  { name: 'observer', provider: 'opencode-go/', id: 'gone-model-v9', missing: true },
  { name: 'councillor', provider: '', id: '', inherited: 'session' },
  { name: 'helper', provider: '', id: '', inherited: 'orchestrator' },
  { name: 'a-very-long-agent-name', provider: 'github-copilot/', id: 'gpt-6.1-sol-275k-long-context', fallbacks: 4, variant: 'medium' },
  // Primary model plus an inherit source: the maximum pill load.
  { name: 'scribe', provider: 'opencode-go/', id: 'deepseek-v4.1-flash', fallbacks: 2, variant: 'high', inherited: 'orchestrator' },
];

const head = `<div class="active-row"><button class="preset-trigger" aria-expanded="false"><span class="preset-name">akita</span><span class="origin-badge">Global</span><span class="chevron">▾</span></button><button class="icon-btn" title="Reload">↻</button><button class="icon-btn" title="Settings">⚙</button></div>`;

const frame = (width, title, rows) => `<section class="frame" style="width:${width + 22}px"><h2>${title} · ${width}px</h2><div class="panel">${head}<div class="agents">${rows.join('')}</div></div></section>`;

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent list preview ${version}</title>
<style>
  ${style}
  html, body { margin: 0; }
  body { background: #15171a; color: #ddd; padding: 16px; display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; }
  .frame { background: #1e2126; border: 1px solid #2c3037; border-radius: 10px; padding: 10px; }
  .frame h2 { margin: 0 0 8px; font: 600 10px/1.3 ui-monospace, monospace; color: #8b919b; text-transform: uppercase; letter-spacing: .06em; }
  .frame .panel { padding: 10px 12px 12px; }
  .stack { display: flex; flex-direction: column; gap: 16px; }
</style></head>
<body>
  <div class="stack">
    ${frame(300, 'akita', AKITA.map(row))}
    ${frame(300, 'edge cases', EDGES.map(row))}
  </div>
  <div class="stack">
    ${frame(380, 'akita', AKITA.map(row))}
    ${frame(380, 'edge cases', EDGES.map(row))}
  </div>
  <div class="stack">
    ${frame(460, 'akita', AKITA.map(row))}
    ${frame(460, 'edge cases', EDGES.map(row))}
  </div>
</body></html>
`;

mkdirSync(new URL('../preview/', import.meta.url), { recursive: true });
writeFileSync(new URL('../preview/agents.html', import.meta.url), html);
console.log('wrote preview/agents.html');
