/**
 * Dev-only preview for the per-agent editor. It copies the <style> block out of
 * panel/index.html and renders the editor states at 300 px and 380 px.
 *
 *   node scripts/preview-editor.mjs && open preview/editor.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const style = panel.slice(panel.indexOf('<style>') + 7, panel.indexOf('</style>'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const scopeLabel = (scope, preset) =>
  scope === 'root' ? 'root agents' : `preset ${preset}`;

const layerLabel = (layer) => (layer === 'global' ? 'Global' : 'This project');

const destSegment = ({ groupLabel, nameA, nameB, selectedA }) => `
  <span class="dest-segment" role="group" aria-label="${groupLabel}">
    <button class="dest-btn${selectedA ? ' is-selected' : ''}" type="button" aria-pressed="${selectedA}">${nameA}</button>
    <button class="dest-btn${selectedA ? '' : ' is-selected'}" type="button" aria-pressed="${!selectedA}">${nameB}</button>
  </span>`;

const destination = ({ agent, preset, scope, layer, path, warning }) => `
  <div class="editor-destination">
    <div class="editor-dest-row">
      <span class="editor-dest-label">Write to</span>
      ${destSegment({ groupLabel: 'Scope', nameA: `preset ${preset}`, nameB: 'root agents', selectedA: scope === 'preset' })}
      <span class="editor-dest-label">in</span>
      ${destSegment({ groupLabel: 'Layer', nameA: 'Global', nameB: 'This project', selectedA: layer === 'global' })}
    </div>
    <div class="editor-path" title="${path}">${path}</div>
    ${warning ? `
    <div class="confirm-warning">
      <div class="confirm-warning-text">
        This project also defines ${agent} in ${scope === 'preset' ? preset : 'root agents'}. The project value will still win here.
      </div>
    </div>` : ''}
  </div>`;

const chainItem = ({ model, variant, rank, isFirst, isLast }) => `
  <div class="chain-item${rank === 1 ? ' is-primary' : ''}">
    <span class="chain-rank">${rank}</span>
    <span class="chain-model" title="${model}">${model}</span>
    <input class="chain-variant" type="text" value="${variant}" placeholder="variant" aria-label="Variant for ${model}">
    <span class="chain-actions">
      <button class="chain-btn" type="button" title="Move up"${isFirst ? ' disabled' : ''}>↑</button>
      <button class="chain-btn" type="button" title="Move down"${isLast ? ' disabled' : ''}>↓</button>
      <button class="chain-btn" type="button" title="Set as primary">★</button>
      <button class="chain-btn is-remove" type="button" title="Remove">×</button>
    </span>
  </div>`;

const pickerRows = () => {
  const models = [
    { m: 'opencode-go/deepseek-v4.1-flash', variants: ['low', 'medium', 'high'] },
    { m: 'opencode-go/kimi-k2.7-code', variants: ['low', 'medium', 'high', 'max'] },
    { m: 'opencode-go/mimo-v2.5', variants: [] },
    { m: 'opencode-go/gemini-4-argon', variants: ['high', 'max'] },
  ];
  return models.map(({ m, variants }) => {
    const option = `
      <button class="picker-option" type="button" title="${m}">
        <span class="picker-option-text">${m}</span>
      </button>`;
    const vwrap = variants.length
      ? `<span class="picker-variants">${variants.map((v) => `<button class="variant-pill" type="button" title="${m} (${v})">${v}</button>`).join('')}</span>`
      : `<input class="variant-input" type="text" placeholder="variant" title="variant">`;
    return `<div class="picker-row">${option}${vwrap}</div>`;
  }).join('');
};

const picker = ({ title }) => `
  <div class="model-picker editor-picker">
    <div class="picker-head">
      <span class="picker-title">${title}</span>
      <button class="icon-btn" type="button" title="Close">×</button>
    </div>
    <div class="picker-filter">Filter: opencode</div>
    <div class="picker-list">
      ${pickerRows()}
    </div>
  </div>`;

const chainSection = ({ chain, pickerOpen }) => `
  <div class="editor-section">
    <button class="editor-section-title" type="button" aria-expanded="true">
      Model chain
      <span class="editor-chevron">▴</span>
    </button>
    <div class="editor-chain">
      <div class="chain-legend">Top = first choice, bottom = fallback</div>
      <div class="chain-list">
        ${chain.map((entry, i, arr) => chainItem({
          model: entry.model,
          variant: entry.variant ?? '',
          rank: i + 1,
          isFirst: i === 0,
          isLast: i === arr.length - 1,
        })).join('')}
      </div>
      <button class="chain-add" type="button">+ Add fallback</button>
    </div>
    ${pickerOpen ? picker({ title: 'Add fallback · 4 models' }) : ''}
  </div>`;

const advancedFields = ({
  inherit = 'none',
  temperature = '',
  skills = '',
  skills_add = '',
  skills_remove = '',
  includeLocal = false,
  mcps = '',
  permDefault = 'ask',
  jsonOpen = false,
  displayName = '',
  color = '',
}) => `
  <div class="editor-advanced">
    <div class="editor-field is-row">
      <span class="editor-label">Inherit model</span>
      <span class="dest-segment" role="group" aria-label="Inherit model from">
        <button class="dest-btn${inherit === 'none' ? ' is-selected' : ''}" type="button" aria-pressed="${inherit === 'none'}">none</button>
        <button class="dest-btn${inherit === 'session' ? ' is-selected' : ''}" type="button" aria-pressed="${inherit === 'session'}">session</button>
        <button class="dest-btn${inherit === 'orchestrator' ? ' is-selected' : ''}" type="button" aria-pressed="${inherit === 'orchestrator'}">orchestrator</button>
      </span>
    </div>

    <div class="editor-field is-row">
      <label class="editor-label" for="editor-temperature">Temperature</label>
      <input class="editor-input" id="editor-temperature" type="number" min="0" max="2" step="0.1" value="${temperature}" style="width: 70px;">
    </div>

    <div class="editor-field">
      <label class="editor-label" for="editor-skills">Skills (comma separated)</label>
      <input class="editor-input" id="editor-skills" type="text" value="${skills}">
    </div>

    <div class="editor-field">
      <label class="editor-label" for="editor-skills-add">Skills to add</label>
      <input class="editor-input" id="editor-skills-add" type="text" value="${skills_add}">
    </div>

    <div class="editor-field">
      <label class="editor-label" for="editor-skills-remove">Skills to remove</label>
      <input class="editor-input" id="editor-skills-remove" type="text" value="${skills_remove}">
    </div>

    <label class="editor-checkbox-row">
      <input type="checkbox"${includeLocal ? ' checked' : ''}>
      <span>Include local skills</span>
    </label>

    <div class="editor-field">
      <label class="editor-label" for="editor-mcps">MCPs (comma separated)</label>
      <input class="editor-input" id="editor-mcps" type="text" value="${mcps}">
    </div>

    <div class="editor-perm">
      <div class="editor-perm-row">
        <span class="editor-label">Default permission</span>
        <span class="dest-segment" role="group" aria-label="Default permission">
          <button class="dest-btn${permDefault === 'allow' ? ' is-selected' : ''}" type="button" aria-pressed="${permDefault === 'allow'}">allow</button>
          <button class="dest-btn${permDefault === 'ask' ? ' is-selected' : ''}" type="button" aria-pressed="${permDefault === 'ask'}">ask</button>
          <button class="dest-btn${permDefault === 'deny' ? ' is-selected' : ''}" type="button" aria-pressed="${permDefault === 'deny'}">deny</button>
        </span>
        <button class="editor-json-btn" type="button">JSON</button>
      </div>
      <textarea class="editor-textarea" placeholder='{"*": "ask", "write-file": "allow"}'${jsonOpen ? '' : ' hidden'}></textarea>
    </div>

    <div class="editor-field">
      <label class="editor-label" for="editor-display">Display name</label>
      <input class="editor-input" id="editor-display" type="text" value="${displayName}">
    </div>

    <div class="editor-field">
      <label class="editor-label" for="editor-color">Color</label>
      <input class="editor-input" id="editor-color" type="text" value="${color}" list="editor-color-suggestions" placeholder="primary / success / warning…">
    </div>
  </div>`;

const advancedSection = ({ open, fields }) => `
  <div class="editor-section">
    <button class="editor-section-title" type="button" aria-expanded="${open}">
      Advanced
      <span class="editor-chevron">${open ? '▴' : '▾'}</span>
    </button>
    ${open ? advancedFields(fields) : '<div class="editor-advanced" hidden></div>'}
  </div>`;

const footer = ({ agent, scope, preset, removeConfirm }) => {
  const from = scope === 'root' ? 'root agents' : `preset ${preset}`;
  return `
  <div class="editor-footer">
    <div class="editor-actions">
      <button class="editor-cancel" type="button">Cancel</button>
      <button class="editor-save" type="button">Save changes</button>
    </div>
    <div class="editor-remove-row">
      ${removeConfirm
        ? `<span class="remove-prompt">Remove ${agent} from ${from}?</span>
           <button class="editor-remove-confirm" type="button">Remove</button>
           <button class="editor-remove-cancel" type="button">Cancel</button>`
        : `<button class="editor-remove" type="button">Remove from ${from}</button>`}
    </div>
  </div>`;
};

const editor = (state) => `
  <div class="agent-editor" role="dialog" aria-label="Edit ${state.agent}" tabindex="-1">
    <div class="editor-head">
      <div class="editor-title">${state.agent}</div>
      <div class="editor-subtitle">editing ${state.preset} · ${layerLabel(state.layer)}</div>
    </div>
    ${destination(state)}
    ${chainSection({ chain: state.chain, pickerOpen: state.pickerOpen })}
    ${advancedSection({ open: state.advancedOpen, fields: state.advanced ?? {} })}
    ${footer({ agent: state.agent, scope: state.scope, preset: state.preset, removeConfirm: state.removeConfirm })}
  </div>`;

const states = {
  presetGlobal: {
    agent: 'designer',
    preset: 'akita',
    scope: 'preset',
    layer: 'global',
    path: '~/.config/opencode/oh-my-opencode-slim.jsonc',
    warning: false,
    chain: [
      { model: 'opencode-go/kimi-k2.7-code', variant: 'high' },
      { model: 'opencode-go/deepseek-v4.1-flash', variant: '' },
      { model: 'opencode-go/mimo-v2.5', variant: '' },
    ],
    pickerOpen: false,
    advancedOpen: false,
    removeConfirm: false,
  },
  rootProjectWarning: {
    agent: 'designer',
    preset: 'akita',
    scope: 'root',
    layer: 'project',
    path: '.opencode/oh-my-opencode-slim.jsonc',
    warning: true,
    chain: [{ model: 'opencode-go/deepseek-v4.1-flash', variant: 'medium' }],
    pickerOpen: false,
    advancedOpen: false,
    removeConfirm: false,
  },
  fourModelChain: {
    agent: 'oracle',
    preset: 'akita',
    scope: 'preset',
    layer: 'global',
    path: '~/.config/opencode/oh-my-opencode-slim.jsonc',
    warning: false,
    chain: [
      { model: 'magpie/agy-cli/gemini-4-argon', variant: 'high' },
      { model: 'opencode-go/deepseek-v4.1-flash', variant: 'medium' },
      { model: 'opencode-go/kimi-k2.7-code', variant: 'low' },
      { model: 'opencode-go/mimo-v2.5', variant: '' },
    ],
    pickerOpen: true,
    advancedOpen: false,
    removeConfirm: false,
  },
  advancedOpen: {
    agent: 'designer',
    preset: 'akita',
    scope: 'preset',
    layer: 'project',
    path: '.opencode/oh-my-opencode-slim.jsonc',
    warning: false,
    chain: [{ model: 'opencode-go/kimi-k2.7-code', variant: 'high' }],
    pickerOpen: false,
    advancedOpen: true,
    removeConfirm: false,
    advanced: {
      inherit: 'none',
      temperature: 0.7,
      skills: 'git, shell',
      skills_add: 'plan',
      skills_remove: '',
      includeLocal: true,
      mcps: '',
      permDefault: 'ask',
      jsonOpen: false,
      displayName: '',
      color: '',
    },
  },
};

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

const stack = () => `
  <div class="stack">
    ${section('preset + global', editor(states.presetGlobal))}
    ${section('root + project + warning', editor(states.rootProjectWarning))}
    ${section('4-model chain + picker', editor(states.fourModelChain))}
    ${section('advanced open', editor(states.advancedOpen))}
  </div>`;

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Agent editor preview ${version}</title>
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
  <datalist id="editor-color-suggestions">
    <option value="primary"></option>
    <option value="success"></option>
    <option value="warning"></option>
    <option value="destructive"></option>
    <option value="info"></option>
    <option value="muted"></option>
  </datalist>

  ${frame(300, 'compact', stack())}
  ${frame(380, 'roomy', stack())}

  <script>
    document.body.addEventListener('click', (e) => {
      const btn = e.target.closest('.editor-section-title');
      if (btn) {
        const section = btn.closest('.editor-section');
        const body = section.querySelector('.editor-advanced');
        if (body) {
          const open = body.hidden;
          body.hidden = !open;
          btn.setAttribute('aria-expanded', String(open));
          const chevron = btn.querySelector('.editor-chevron');
          if (chevron) chevron.textContent = open ? '▴' : '▾';
        }
        return;
      }
      const jsonBtn = e.target.closest('.editor-json-btn');
      if (jsonBtn) {
        const perm = jsonBtn.closest('.editor-perm');
        const ta = perm.querySelector('.editor-textarea');
        if (ta) {
          ta.hidden = !ta.hidden;
          jsonBtn.textContent = ta.hidden ? 'JSON' : 'Hide JSON';
        }
      }
    });
  </script>
</body>
</html>`;

mkdirSync(new URL('../preview/', import.meta.url), { recursive: true });
writeFileSync(new URL('../preview/editor.html', import.meta.url), html);
console.log('wrote preview/editor.html');
