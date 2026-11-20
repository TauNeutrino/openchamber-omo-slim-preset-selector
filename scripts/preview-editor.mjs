/**
 * Dev-only preview for the per-agent editor and its model/variant wizard. It
 * copies the <style> block out of panel/index.html and renders the real markup
 * shapes at 300 px and 380 px, so CSS/layout changes can be judged without the
 * OpenChamber host.
 *
 *   node scripts/preview-editor.mjs && open preview/editor.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const style = panel.slice(panel.indexOf('<style>') + 7, panel.indexOf('</style>'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const destination = ({ agent, preset, scope, layer, path, warning }) => `
  <div class="editor-destination">
    <div class="editor-dest-row">
      <span class="editor-dest-label">Write to</span>
      <span class="dest-segment" role="group" aria-label="Scope">
        <button class="dest-btn${scope === 'preset' ? ' is-selected' : ''}" type="button" aria-pressed="${scope === 'preset'}">preset ${preset}</button>
        <button class="dest-btn${scope === 'root' ? ' is-selected' : ''}" type="button" aria-pressed="${scope === 'root'}">root agents</button>
      </span>
      <span class="editor-dest-label">in</span>
      <span class="dest-segment" role="group" aria-label="Layer">
        <button class="dest-btn${layer === 'global' ? ' is-selected' : ''}" type="button" aria-pressed="${layer === 'global'}">Global</button>
        <button class="dest-btn${layer === 'project' ? ' is-selected' : ''}" type="button" aria-pressed="${layer === 'project'}">This project</button>
      </span>
    </div>
    <div class="editor-path" title="${path}">${path}</div>
    ${warning ? `
    <div class="confirm-warning">
      <div class="confirm-warning-text">
        This project also defines ${agent} in ${scope === 'preset' ? preset : 'root agents'}. The project value will still win here.
      </div>
    </div>` : ''}
  </div>`;

/** Chain entry: model name opens the wizard at step 1, the variant chip at step 2. */
const chainItem = ({ model, variant, rank, isFirst, isLast, flash }) => `
  <div class="chain-item${rank === 1 ? ' is-primary' : ''}${flash ? ' is-flash' : ''}">
    <span class="chain-rank">${rank}</span>
    <span class="chain-model" title="${model}">${model}</span>
    <button class="chain-variant${variant ? '' : ' is-empty'}" type="button" title="Edit variant · ${model}">${variant || 'Variante…'}</button>
    <span class="chain-actions">
      <button class="chain-btn" type="button" title="Move up"${isFirst ? ' disabled' : ''}>↑</button>
      <button class="chain-btn" type="button" title="Move down"${isLast ? ' disabled' : ''}>↓</button>
      <button class="chain-btn" type="button" title="Set as primary">★</button>
      <button class="chain-btn is-remove" type="button" title="Remove">×</button>
    </span>
  </div>`;

const chainSection = ({ chain }) => `
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
          flash: entry.flash,
        })).join('')}
      </div>
      <button class="chain-add" type="button">+ Add fallback</button>
    </div>
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
      <div class="editor-subtitle">editing ${state.preset} · ${state.layer === 'global' ? 'Global' : 'This project'}</div>
    </div>
    ${destination(state)}
    ${chainSection({ chain: state.chain })}
    ${advancedSection({ open: state.advancedOpen, fields: state.advanced ?? {} })}
    ${footer({ agent: state.agent, scope: state.scope, preset: state.preset, removeConfirm: state.removeConfirm })}
  </div>`;

/* ------------------------------------------------------------------ wizard */

const STEP_LABELS = ['Model', 'Variant', 'Review'];
const STEP_TITLES = ['Choose model', 'Choose variant', 'Review'];

const wizardSteps = (step) => {
  const current = ['model', 'variant', 'review'].indexOf(step);
  return `<ol class="wizard-steps" aria-label="Steps">
    ${STEP_LABELS.map((label, index) => `
      <li class="${index === current ? 'is-current' : index < current ? 'is-done' : ''}"${index === current ? ' aria-current="step"' : ''}>
        <span class="wizard-dot">${index < current ? '✓' : index + 1}</span>
        <span class="wizard-step-label">${label}</span>
      </li>`).join('')}
  </ol>`;
};

const wizardCard = ({ mode, pos, step, body }) => `
  <div class="agent-wizard" role="dialog" aria-label="oracle: ${STEP_TITLES[['model', 'variant', 'review'].indexOf(step)]}" tabindex="-1">
    <div class="wizard-head">
      <div class="wizard-titles">
        <div class="wizard-kicker">${mode === 'replace' ? `Replace model · slot ${pos}` : `Add fallback · slot ${pos}`}</div>
        <div class="wizard-title">${STEP_TITLES[['model', 'variant', 'review'].indexOf(step)]}</div>
      </div>
      <button class="icon-btn" type="button" title="Cancel">×</button>
    </div>
    ${wizardSteps(step)}
    ${body}
  </div>`;

const modelRow = (id, state = '') => {
  const blocked = state === 'blocked';
  const current = state === 'current';
  const tags = current
    ? '<span class="wizard-tags"><span class="wizard-tag is-current">current</span></span>'
    : blocked
      ? '<span class="wizard-tags"><span class="wizard-tag">already in chain</span></span>'
      : '';
  return `<button class="wizard-model-row${current ? ' is-current' : ''}${blocked ? ' is-blocked' : ''}" type="button"${blocked ? ' disabled' : ''}>
    <span class="wizard-model-name">${id}</span>${tags}
  </button>`;
};

const wizardModelBody = () => `
  <div class="wizard-body">
    <p class="wizard-context">Replaces <code>github/gpt-5</code></p>
    <input class="editor-input wizard-search" type="search" placeholder="Search models, e.g. glm or deepseek" aria-label="Search models">
    <div class="wizard-models">
      ${modelRow('opencode-go/deepseek-v4.1-flash')}
      ${modelRow('opencode-go/gemini-4-argon')}
      ${modelRow('github/gpt-5', 'current')}
      ${modelRow('opencode-go/kimi-k2.7-code', 'blocked')}
      ${modelRow('opencode-go/glm-5.3-flash', 'blocked')}
      ${modelRow('opencode-go/mimo-v2.5')}
      ${modelRow('opencode-go/beam-free')}
      ${modelRow('opencode-go/qwen3.8-flash')}
      ${modelRow('opencode/mimo-v2.6-flash-free')}
      ${modelRow('nvidia/minimaxai/minimax-m3.1-flash')}
      ${modelRow('magpie/agy-cli/gemini-4-argon')}
      ${modelRow('opencode-go/claude-haiku-5-5')}
    </div>
  </div>`;

const wizardVariantBody = () => `
  <div class="wizard-body">
    <p class="wizard-context">Model <code>github/gpt-5</code><button class="wizard-link" type="button">change</button></p>
    <div class="wizard-variants" role="radiogroup" aria-label="Variant">
      <button class="wizard-variant-option is-sans" type="button" role="radio" aria-checked="false">no variant</button>
      <button class="wizard-variant-option" type="button" role="radio" aria-checked="false">low</button>
      <button class="wizard-variant-option" type="button" role="radio" aria-checked="false">medium</button>
      <button class="wizard-variant-option" type="button" role="radio" aria-checked="false">high</button>
      <button class="wizard-variant-option" type="button" role="radio" aria-checked="false">xhigh <span class="wizard-bisher">previous</span></button>
      <button class="wizard-variant-option is-sans" type="button" role="radio" aria-checked="true">
        Custom variant …
      </button>
    </div>
    <div class="wizard-custom">
      <label class="editor-label" for="wizard-custom-variant">Custom variant</label>
      <input class="editor-input wizard-custom-input" id="wizard-custom-variant" type="text" value="bad value" aria-invalid="true">
      <p class="wizard-error">Only a–z, 0–9, dot and hyphen; at most 24 characters.</p>
    </div>
  </div>`;

const wizardReviewBody = () => `
  <div class="wizard-body">
    <div class="wizard-target">
      <span>Writes to</span>
      <b>preset akita · Global</b>
      <span class="wizard-path">~/.config/opencode/oh-my-opencode-slim.json</span>
    </div>
    <div class="wizard-diff">
      <div class="wizard-diff-row is-old">
        <span class="wizard-diff-label">Slot 1 · before</span>
        <span class="wizard-diff-model">github/gpt-5</span>
        <span class="variant">xhigh</span>
      </div>
      <div class="wizard-diff-row is-new">
        <span class="wizard-diff-label">Slot 1 · after</span>
        <span class="wizard-diff-model">opencode-go/deepseek-v4.1-flash</span>
        <span class="variant">medium</span>
      </div>
    </div>
    <div class="wizard-band">
      <span class="wizard-band-title">Rest of the chain · unchanged</span>
      <ol>
        <li><span class="chain-rank">2</span><span class="wizard-band-model">opencode-go/kimi-k2.7-code</span><span class="variant">low</span></li>
        <li><span class="chain-rank">3</span><span class="wizard-band-model">opencode-go/mimo-v2.5</span><span class="wizard-variant-none">none</span></li>
      </ol>
    </div>
    <div class="wizard-footer">
      <button class="editor-save wizard-apply" type="button">Apply</button>
    </div>
    <p class="wizard-note">Apply changes only this slot.</p>
  </div>`;

const states = {
  presetGlobal: {
    agent: 'designer',
    preset: 'akita',
    scope: 'preset',
    layer: 'global',
    path: '~/.config/opencode/oh-my-opencode-slim.json',
    warning: false,
    chain: [
      { model: 'opencode-go/kimi-k2.7-code', variant: 'high' },
      { model: 'opencode-go/deepseek-v4.1-flash', variant: '' },
      { model: 'opencode-go/mimo-v2.5', variant: '' },
    ],
    advancedOpen: false,
    removeConfirm: false,
  },
  rootProjectWarning: {
    agent: 'designer',
    preset: 'akita',
    scope: 'root',
    layer: 'project',
    path: '.opencode/oh-my-opencode-slim.json',
    warning: true,
    chain: [{ model: 'opencode-go/deepseek-v4.1-flash', variant: 'medium' }],
    advancedOpen: false,
    removeConfirm: false,
  },
  advancedOpen: {
    agent: 'designer',
    preset: 'akita',
    scope: 'preset',
    layer: 'project',
    path: '.opencode/oh-my-opencode-slim.json',
    warning: false,
    chain: [{ model: 'opencode-go/kimi-k2.7-code', variant: 'high', flash: true }],
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
    ${section('wizard · model (current + blocked)', wizardCard({ mode: 'replace', pos: 1, step: 'model', body: wizardModelBody() }))}
    ${section('wizard · variant + custom error', wizardCard({ mode: 'replace', pos: 1, step: 'variant', body: wizardVariantBody() }))}
    ${section('wizard · review diff', wizardCard({ mode: 'replace', pos: 1, step: 'review', body: wizardReviewBody() }))}
    ${section('advanced open + applied flash', editor(states.advancedOpen))}
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
