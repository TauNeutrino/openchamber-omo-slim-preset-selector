/**
 * Dev-only preview for the preset-scope UI. It copies the <style> block out of
 * panel/index.html and renders the new active-row states, confirm dialog
 * variants and the badged preset list at 300 px and 380 px.
 *
 *   node scripts/preview-scope.mjs && open preview/scope.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const style = panel.slice(panel.indexOf('<style>') + 7, panel.indexOf('</style>'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const iconButtons = `
  <button class="icon-btn" title="Reload">↻</button>
  <button class="icon-btn" title="Settings">⚙</button>
`;

const scopeControl = ({ badge, hint }) => {
  const hintHtml = hint
    ? `<span class="scope-hint"><span class="scope-hint-text">${hint}</span></span>`
    : '';
  return `<span class="scope-control"><span class="origin-badge ${badge.class}">${badge.text}</span>${hintHtml}</span>`;
};

const activeRow = ({ name, badge, hint, clear }) => `
<div class="active-row">
  <button class="preset-trigger" aria-expanded="false" type="button">
    <span class="preset-name">${name}</span>
    ${scopeControl({ badge, hint })}
    <span class="chevron">▾</span>
  </button>
  ${clear ? `<button class="icon-btn clear-override" title="${clear.title}" type="button">${clear.icon}</button>` : ''}
  ${iconButtons}
</div>`;

const activeStates = [
  {
    title: 'global, no project',
    row: { name: 'akita', badge: { class: '', text: 'Global' } },
  },
  {
    title: 'global, project open',
    row: { name: 'akita', badge: { class: '', text: 'Global' }, hint: 'this project' },
  },
  {
    title: 'project override, shadowed global',
    row: {
      name: 'minimal',
      badge: { class: 'is-project', text: 'Project' },
      hint: '↳ global akita',
      clear: { title: 'Clear project override — use global akita', icon: '×' },
    },
  },
  {
    title: 'project override, project-only',
    row: {
      name: 'minimal',
      badge: { class: 'is-project', text: 'Project' },
      hint: 'only in this project',
      clear: { title: 'Clear project override', icon: '×' },
    },
  },
  {
    title: 'project override, no global preset',
    row: {
      name: 'minimal',
      badge: { class: 'is-project', text: 'Project' },
      hint: '↳ no global preset',
      clear: { title: 'Clear project override', icon: '×' },
    },
  },
];

const scopeChoice = ({
  globalSelected = false,
  projectSelected = false,
  globalDisabled = false,
  projectDisabled = false,
  note = '',
  warning = null,
}) => {
  const gClass = globalSelected ? 'scope-choice is-selected' : 'scope-choice';
  const pClass = projectSelected ? 'scope-choice is-selected' : 'scope-choice';
  const gAttr = globalDisabled ? 'disabled class="scope-choice is-disabled"' : `class="${gClass}"`;
  const pAttr = projectDisabled ? 'disabled class="scope-choice is-disabled"' : `class="${pClass}"`;
  const noteHtml = note ? `<p class="confirm-scope-note">${note}</p>` : '';
  const warningHtml = warning
    ? `<div class="confirm-warning">
        <div class="confirm-warning-text">${warning.text}</div>
        <label class="confirm-checkbox-row">
          <input type="checkbox">
          <span>${warning.checkbox}</span>
        </label>
      </div>`
    : '';
  return `<div class="confirm-scope">
    <button type="button" ${gAttr} aria-pressed="${globalSelected}">Apply globally</button>
    <button type="button" ${pAttr} aria-pressed="${projectSelected}">This project only</button>
    ${noteHtml}
  </div>${warningHtml}`;
};

const confirmCard = ({ title, name, path, scope }) => `
<div class="confirm">
  <div class="confirm-title">Apply preset “${name}”</div>
  <div class="confirm-body">Writes to <code>${path}</code>.</div>
  ${scope}
  <div class="confirm-hint">Effective after Managed Service restart.</div>
  <div class="confirm-actions">
    <button class="confirm-cancel" type="button">Cancel</button>
    <button class="confirm-apply" type="button">Apply</button>
  </div>
</div>`;

const confirmStates = [
  {
    title: 'global scope',
    name: 'akita',
    path: '~/.config/opencode/oh-my-opencode-slim.jsonc',
    scope: scopeChoice({ globalSelected: true }),
  },
  {
    title: 'project scope',
    name: 'minimal',
    path: '.opencode/oh-my-opencode-slim.jsonc',
    scope: scopeChoice({ projectSelected: true }),
  },
  {
    title: 'global + clear override warning',
    name: 'akita',
    path: '~/.config/opencode/oh-my-opencode-slim.jsonc',
    scope: scopeChoice({
      globalSelected: true,
      warning: {
        text: 'Project override “minimal” is active. The global change will not take effect here unless the override is cleared.',
        checkbox: 'Also clear the project override so it takes effect here',
      },
    }),
  },
  {
    title: 'project disabled (no project)',
    name: 'akita',
    path: '~/.config/opencode/oh-my-opencode-slim.jsonc',
    scope: scopeChoice({ globalSelected: true, projectDisabled: true, note: 'Project scope is unavailable because no project is open.' }),
  },
  {
    title: 'global disabled (project-only preset)',
    name: 'minimal',
    path: '.opencode/oh-my-opencode-slim.jsonc',
    scope: scopeChoice({ projectSelected: true, globalDisabled: true, note: '“minimal” is not defined in the global layer.' }),
  },
];

const listOption = ({ name, model, origin, active, globalDefault, extends: ext }) => {
  const badgeClass = origin === 'project' ? 'is-project' : origin === 'mixed' ? 'is-mixed' : '';
  const badgeText = origin === 'project' ? 'Project' : origin === 'mixed' ? 'Global + Project' : 'Global';
  const check = active ? '<span class="option-check">✓</span>' : '';
  const marker = globalDefault ? '<span class="option-marker is-global-default">global default</span>' : '';
  const extBadge = ext ? `<span class="option-extends">↳ ${ext}</span>` : '';
  return `
  <button class="preset-option" type="button" role="option" aria-selected="${active ? 'true' : 'false'}" data-active="${active ? 'true' : 'false'}">
    <span class="option-label">
      <span class="option-name">${name}</span>
      ${model ? `<span class="option-model">${model}</span>` : ''}
      <span class="option-meta">${marker}${extBadge}</span>
    </span>
    <span class="origin-badge ${badgeClass}">${badgeText}</span>
    ${check}
  </button>`;
};

const listRows = [
  { name: 'akita', model: 'deepseek-v4.1-flash', origin: 'global', globalDefault: true },
  { name: 'minimal', model: 'gemini-4-argon', origin: 'project', active: true },
  { name: 'night-shift', model: 'kimi-k2.7-code', origin: 'mixed' },
  { name: 'base', model: 'mimo-v2.5', origin: 'global', extends: 'core' },
  { name: 'pro', model: 'deepseek-v4.1-flash', origin: 'project' },
];

const presetList = `
<div class="preset-list" role="listbox" aria-label="Available presets">
  ${listRows.map(listOption).join('')}
</div>`;

const panelWrap = (content) => `<div class="panel panel-preview">${content}</div>`;

const section = (title, body) => `
<div class="section">
  <div class="mini-title">${title}</div>
  ${body}
</div>`;

const frame = (width, title, body) => `
<section class="frame" style="width:${width + 22}px">
  <h2>${title} · ${width}px</h2>
  ${body}
</section>`;

const stack300 = `
<div class="stack">
  ${section('active-row states', activeStates.map((s) => panelWrap(activeRow(s.row))).join(''))}
  ${section('confirm dialogs', confirmStates.map((s) => panelWrap(confirmCard(s))).join(''))}
  ${section('preset list', panelWrap(presetList))}
</div>`;

const stack380 = `
<div class="stack">
  ${section('active-row states', activeStates.map((s) => panelWrap(activeRow(s.row))).join(''))}
  ${section('confirm dialogs', confirmStates.map((s) => panelWrap(confirmCard(s))).join(''))}
  ${section('preset list', panelWrap(presetList))}
</div>`;

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Preset scope preview ${version}</title>
  <style>
    ${style}
    html, body { margin: 0; }
    body {
      background: #15171a;
      color: #ddd;
      padding: 16px;
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      align-items: flex-start;
    }
    .frame {
      background: #1e2126;
      border: 1px solid #2c3037;
      border-radius: 10px;
      padding: 10px;
    }
    .frame h2 {
      margin: 0 0 8px;
      font: 600 10px/1.3 ui-monospace, monospace;
      color: #8b919b;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .panel-preview { padding: 10px 12px 12px; }
    .mini-title {
      margin: 12px 0 6px;
      font: 600 10px/1.3 ui-monospace, monospace;
      color: #8b919b;
      text-transform: uppercase;
      letter-spacing: .06em;
    }
    .mini-title:first-child { margin-top: 0; }
    .stack { display: flex; flex-direction: column; gap: 16px; }
    .section { display: flex; flex-direction: column; gap: 6px; }
  </style>
</head>
<body>
  ${frame('300', 'compact', stack300)}
  ${frame('380', 'roomy', stack380)}
</body>
</html>`;

mkdirSync(new URL('../preview/', import.meta.url), { recursive: true });
writeFileSync(new URL('../preview/scope.html', import.meta.url), html);
console.log('wrote preview/scope.html');
