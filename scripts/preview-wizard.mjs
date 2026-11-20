/**
 * Dev-only interactive harness for the model/variant wizard. It reuses the real
 * panel stylesheet and the same DOM shapes as `paintAgentWizard`, so a
 * Playwright click-through can verify the step flow without an OpenChamber host.
 *
 *   node scripts/preview-wizard.mjs && open preview/wizard.html
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const panel = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
const style = panel.slice(panel.indexOf('<style>') + 7, panel.indexOf('</style>'));
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const html = `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Wizard interaction harness ${version}</title>
  <style>
    ${style}
    html, body { margin: 0; background: #15171a; color: #ddd; }
    body { padding: 16px; font: 11.5px/1.45 ui-sans-serif, system-ui, sans-serif; }
    .harness { width: 322px; max-width: 100%; display: flex; flex-direction: column; gap: 14px; }
    .harness h2 { margin: 0; font: 600 10px/1.3 ui-monospace, monospace; color: #8b919b; text-transform: uppercase; letter-spacing: .06em; }
    .harness-panel { padding: 10px 12px 12px; background: #1e2126; border: 1px solid #2c3037; border-radius: 10px; }
    .closed { padding: 10px; color: #8b919b; font-size: 11px; }
    .harness-chain { display: flex; flex-direction: column; gap: 4px; }
  </style>
</head>
<body>
  <div class="harness">
    <section>
      <h2>Wizard</h2>
      <div class="harness-panel" id="wizard"></div>
    </section>
    <section>
      <h2>Draft chain after Apply</h2>
      <div class="harness-panel harness-chain" id="chain"></div>
    </section>
  </div>

  <script>
    (function () {
      'use strict';
      var CATALOG = [
        { id: 'opencode-go/deepseek-v4.1-flash', variants: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'opencode-go/gemini-4-argon', variants: ['high', 'max'] },
        { id: 'opencode-go/kimi-k2.7-code', variants: ['low', 'medium', 'high', 'max'] },
        { id: 'opencode-go/glm-5.3-flash', variants: ['medium', 'high', 'max'] },
        { id: 'opencode-go/mimo-v2.5', variants: [] },
        { id: 'opencode-go/beam-free', variants: ['low', 'medium'] },
        { id: 'github/gpt-5', variants: ['low', 'medium', 'high', 'xhigh'] },
        { id: 'magpie/agy-cli/gemini-4-argon', variants: [] }
      ];
      var VARIANT_RE = /^[a-z0-9][a-z0-9._-]{0,23}$/;
      var chain = [
        { model: 'github/gpt-5', variant: 'xhigh' },
        { model: 'opencode-go/kimi-k2.7-code', variant: 'low' },
        { model: 'opencode-go/mimo-v2.5', variant: null }
      ];
      var wizard = null;
      var flash = null;
      var filter = '';

      function normalize(raw) {
        var value = String(raw || '').trim().toLowerCase();
        return value && VARIANT_RE.test(value) ? value : null;
      }
      function variantsOf(model) {
        var entry = CATALOG.filter(function (item) { return item.id === model; })[0];
        return entry ? entry.variants : [];
      }
      function blocked(model) {
        if (!wizard) return false;
        return chain.some(function (entry, index) {
          return entry.model === model && !(wizard.mode === 'replace' && index === wizard.index);
        });
      }
      function entryOf() {
        if (!wizard || !wizard.model) return null;
        if (wizard.variantKind === 'custom') {
          var custom = normalize(wizard.customText);
          return custom ? { model: wizard.model, variant: custom } : null;
        }
        var variant = wizard.variantKind === 'pick' ? wizard.variant : '';
        return variant ? { model: wizard.model, variant: variant } : { model: wizard.model };
      }
      function unchanged() {
        if (!wizard || wizard.mode !== 'replace') return false;
        var entry = entryOf();
        var current = chain[wizard.index];
        return !!entry && !!current && current.model === entry.model
          && (current.variant || '') === (entry.variant || '');
      }
      function esc(value) {
        return String(value).replace(/[&<>"]/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
      }

      function open(mode, index, step, locked) {
        var current = mode === 'replace' ? chain[index] : null;
        wizard = {
          mode: mode,
          index: index,
          step: step || 'model',
          model: step === 'variant' ? current.model : null,
          variantKind: step === 'variant' && current && current.variant ? 'pick' : 'none',
          variant: step === 'variant' && current ? current.variant : null,
          customText: '',
          origModel: current ? current.model : null,
          origVariant: current ? current.variant : null,
          lockedModel: !!locked
        };
        filter = '';
        render();
      }

      function steps() {
        var order = ['model', 'variant', 'review'];
        var labels = ['Model', 'Variant', 'Review'];
        var current = order.indexOf(wizard.step);
        return '<ol class="wizard-steps" aria-label="Steps">' + order.map(function (step, index) {
          return '<li class="' + (index === current ? 'is-current' : index < current ? 'is-done' : '') + '"'
            + (index === current ? ' aria-current="step"' : '') + '>'
            + '<span class="wizard-dot">' + (index < current ? '✓' : index + 1) + '</span>'
            + '<span class="wizard-step-label">' + labels[index] + '</span></li>';
        }).join('') + '</ol>';
      }

      function modelStep() {
        var current = wizard.mode === 'replace' ? chain[wizard.index] : null;
        var context = current
          ? 'Replaces <code>' + esc(current.model) + '</code>'
          : 'Appended as the last fallback at slot ' + (wizard.index + 1) + '.';
        var items = CATALOG.filter(function (item) {
          return !filter || item.id.toLowerCase().indexOf(filter) !== -1;
        });
        var rows = items.map(function (item) {
          var isBlocked = blocked(item.id);
          var isCurrent = !!current && item.id === current.model;
          return '<button class="wizard-model-row' + (isCurrent ? ' is-current' : '') + (isBlocked ? ' is-blocked' : '') + '" type="button"'
            + (isBlocked ? ' disabled' : '') + ' data-model="' + esc(item.id) + '"' + (isCurrent ? ' aria-current="true"' : '') + '>'
            + '<span class="wizard-model-name">' + esc(item.id) + '</span>'
            + (isCurrent || isBlocked
              ? '<span class="wizard-tags">'
                + (isCurrent ? '<span class="wizard-tag is-current">current</span>' : '')
                + (isBlocked ? '<span class="wizard-tag">already in chain</span>' : '')
                + '</span>'
              : '')
            + '</button>';
        }).join('');
        if (!rows) rows = '<div class="wizard-empty">No models match the filter.</div>';
        return '<div class="wizard-body">'
          + '<p class="wizard-context">' + context + '</p>'
          + '<input class="editor-input wizard-search" type="search" placeholder="Search models" aria-label="Search models" value="' + esc(filter) + '">'
          + '<div class="wizard-models">' + rows + '</div>'
          + '</div>';
      }

      function variantStep() {
        var known = variantsOf(wizard.model);
        if (wizard.origModel === wizard.model && wizard.origVariant && known.indexOf(wizard.origVariant) === -1) {
          known = known.concat([wizard.origVariant]);
        }
        var previous = wizard.mode === 'replace' && wizard.origModel === wizard.model ? wizard.origVariant : null;
        var options = '<button class="wizard-variant-option is-sans" type="button" data-kind="none" aria-checked="'
          + (wizard.variantKind === 'none') + '">no variant</button>';
        options += known.map(function (variant) {
          return '<button class="wizard-variant-option" type="button" data-kind="pick" data-variant="' + esc(variant)
            + '" aria-checked="' + (wizard.variantKind === 'pick' && wizard.variant === variant) + '">'
            + esc(variant) + (variant === previous ? '<span class="wizard-bisher">previous</span>' : '') + '</button>';
        }).join('');
        options += '<button class="wizard-variant-option is-sans" type="button" data-kind="custom" aria-checked="'
          + (wizard.variantKind === 'custom') + '">Custom variant …</button>';
        var custom = '';
        if (wizard.variantKind === 'custom') {
          var bad = wizard.customText.trim() !== '' && !normalize(wizard.customText);
          custom = '<div class="wizard-custom">'
            + '<label class="editor-label" for="wizard-custom-variant">Custom variant</label>'
            + '<input class="editor-input wizard-custom-input" id="wizard-custom-variant" type="text" maxlength="24" value="' + esc(wizard.customText) + '"'
            + (bad ? ' aria-invalid="true"' : '') + '>'
            + '<p class="wizard-error"' + (bad ? '' : ' hidden') + '>Only a–z, 0–9, dot and hyphen; at most 24 characters.</p>'
            + '</div>';
        }
        return '<div class="wizard-body">'
          + '<p class="wizard-context">Model <code>' + esc(wizard.model) + '</code>'
          + (wizard.lockedModel ? '' : '<button class="wizard-link" type="button" data-act="change-model">change</button>')
          + '</p>'
          + '<div class="wizard-variants" role="radiogroup" aria-label="Variant">' + options + '</div>'
          + (known.length ? '' : '<p class="wizard-note">No variants are known for this model.</p>')
          + custom
          + '</div>';
      }

      function reviewStep() {
        var entry = entryOf();
        var rest = chain.map(function (ref, index) { return { ref: ref, index: index }; })
          .filter(function (item) { return !(wizard.mode === 'replace' && item.index === wizard.index); });
        var old = wizard.mode === 'replace' ? chain[wizard.index] : null;
        return '<div class="wizard-body">'
          + '<div class="wizard-target"><span>Writes to</span><b>preset akita · Global</b>'
          + '<span class="wizard-path">~/.config/opencode/oh-my-opencode-slim.json</span></div>'
          + '<div class="wizard-diff">'
          + (old ? '<div class="wizard-diff-row is-old"><span class="wizard-diff-label">Slot ' + (wizard.index + 1) + ' · before</span>'
            + '<span class="wizard-diff-model">' + esc(old.model) + '</span>'
            + (old.variant ? '<span class="variant">' + esc(old.variant) + '</span>' : '<span class="wizard-variant-none">none</span>') + '</div>' : '')
          + (entry ? '<div class="wizard-diff-row is-new"><span class="wizard-diff-label">Slot ' + (wizard.index + 1) + ' · after</span>'
            + '<span class="wizard-diff-model">' + esc(entry.model) + '</span>'
            + (entry.variant ? '<span class="variant">' + esc(entry.variant) + '</span>' : '<span class="wizard-variant-none">none</span>') + '</div>' : '')
          + '</div>'
          + (rest.length
            ? '<div class="wizard-band"><span class="wizard-band-title">Rest of the chain · unchanged</span><ol>'
              + rest.map(function (item) {
                return '<li><span class="chain-rank">' + (item.index + 1) + '</span>'
                  + '<span class="wizard-band-model">' + esc(item.ref.model) + '</span>'
                  + (item.ref.variant ? '<span class="variant">' + esc(item.ref.variant) + '</span>' : '<span class="wizard-variant-none">none</span>')
                  + '</li>';
              }).join('') + '</ol></div>'
            : '')
          + (unchanged() ? '<p class="wizard-note">No change: slot ' + (wizard.index + 1) + ' stays as it is.</p>' : '')
          + '<div class="wizard-footer"><button class="editor-save wizard-apply" type="button"'
          + (entry && !unchanged() ? '' : ' disabled') + '>Apply</button></div>'
          + (unchanged() ? '' : '<p class="wizard-note">Apply changes only this slot.</p>')
          + '</div>';
      }

      function renderWizard() {
        var host = document.getElementById('wizard');
        if (!wizard) {
          host.innerHTML = '<div class="closed">Wizard closed. <button class="wizard-link" type="button" data-act="open">Open again</button></div>';
          return;
        }
        var titles = { model: 'Choose model', variant: 'Choose variant', review: 'Review' };
        host.innerHTML = '<div class="agent-wizard" role="dialog">'
          + '<div class="wizard-head"><div class="wizard-titles">'
          + '<div class="wizard-kicker">' + (wizard.mode === 'replace' ? 'Replace model · slot ' + (wizard.index + 1) : 'Add fallback · slot ' + (wizard.index + 1)) + '</div>'
          + '<div class="wizard-title">' + titles[wizard.step] + '</div></div>'
          + '<button class="icon-btn" type="button" data-act="cancel" title="Cancel">×</button></div>'
          + steps()
          + (wizard.step === 'model' ? modelStep() : wizard.step === 'variant' ? variantStep() : reviewStep())
          + '</div>';
      }

      function renderChain() {
        document.getElementById('chain').innerHTML = chain.map(function (entry, index) {
          return '<div class="chain-item' + (index === 0 ? ' is-primary' : '') + (flash === index ? ' is-flash' : '') + '" data-chain-index="' + index + '">'
            + '<span class="chain-rank">' + (index + 1) + '</span>'
            + '<span class="chain-model">' + esc(entry.model) + '</span>'
            + '<button class="chain-variant' + (entry.variant ? '' : ' is-empty') + '" type="button" data-edit-variant="' + index + '">'
            + (entry.variant ? esc(entry.variant) : 'Variante…') + '</button>'
            + '</div>';
        }).join('');
        flash = null;
      }

      function render() {
        renderWizard();
        renderChain();
      }

      function chooseModel(model) {
        var same = wizard.mode === 'replace' && wizard.origModel === model && !!wizard.origVariant;
        wizard.model = model;
        wizard.step = 'variant';
        wizard.variantKind = same ? 'pick' : 'none';
        wizard.variant = same ? wizard.origVariant : null;
        wizard.customText = '';
        render();
      }
      function chooseVariant(kind, value) {
        wizard.variantKind = kind;
        wizard.variant = kind === 'pick' ? value : null;
        wizard.customText = '';
        wizard.step = 'review';
        render();
      }
      function apply() {
        var entry = entryOf();
        if (!entry || unchanged()) return;
        if (wizard.mode === 'replace') {
          chain[wizard.index] = entry;
          flash = wizard.index;
        } else {
          chain.push(entry);
          flash = chain.length - 1;
        }
        wizard = null;
        render();
      }

      document.getElementById('wizard').addEventListener('click', function (event) {
        var act = event.target.closest('[data-act]');
        if (act) {
          var name = act.getAttribute('data-act');
          if (name === 'cancel') { wizard = null; render(); return; }
          if (name === 'open') { open('replace', 0); return; }
          if (name === 'change-model') { wizard.step = 'model'; render(); return; }
        }
        var model = event.target.closest('[data-model]');
        if (model && !model.disabled) { chooseModel(model.getAttribute('data-model')); return; }
        var option = event.target.closest('[data-kind]');
        if (option) {
          var kind = option.getAttribute('data-kind');
          if (kind === 'custom') {
            wizard.variantKind = 'custom';
            wizard.variant = null;
            render();
            var input = document.querySelector('.wizard-custom-input');
            if (input) input.focus();
          } else {
            chooseVariant(kind, option.getAttribute('data-variant'));
          }
          return;
        }
        if (event.target.closest('.wizard-apply')) { apply(); return; }
      });

      document.getElementById('wizard').addEventListener('input', function (event) {
        if (event.target.classList.contains('wizard-search')) {
          filter = event.target.value;
          var list = document.querySelector('.wizard-models');
          if (list) {
            var items = CATALOG.filter(function (item) {
              return !filter || item.id.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
            });
            list.innerHTML = items.map(function (item) {
              var isBlocked = blocked(item.id);
              var current = wizard.mode === 'replace' ? chain[wizard.index] : null;
              var isCurrent = !!current && item.id === current.model;
              return '<button class="wizard-model-row' + (isCurrent ? ' is-current' : '') + (isBlocked ? ' is-blocked' : '') + '" type="button"'
                + (isBlocked ? ' disabled' : '') + ' data-model="' + esc(item.id) + '">'
                + '<span class="wizard-model-name">' + esc(item.id) + '</span></button>';
            }).join('') || '<div class="wizard-empty">No models match the filter.</div>';
          }
          return;
        }
        if (event.target.classList.contains('wizard-custom-input')) {
          wizard.customText = event.target.value;
          var bad = wizard.customText.trim() !== '' && !normalize(wizard.customText);
          event.target.setAttribute('aria-invalid', String(bad));
          var error = document.querySelector('.wizard-error');
          if (error) { error.hidden = !bad; }
        }
      });

      document.getElementById('wizard').addEventListener('change', function (event) {
        if (!event.target.classList.contains('wizard-custom-input')) return;
        var normalized = normalize(wizard.customText);
        if (!normalized) return;
        wizard.variantKind = 'custom';
        wizard.variant = normalized;
        wizard.customText = normalized;
        wizard.step = 'review';
        render();
      });

      document.getElementById('wizard').addEventListener('keydown', function (event) {
        if (event.key !== 'Enter' || !event.target.classList.contains('wizard-custom-input')) return;
        event.preventDefault();
        var normalized = normalize(wizard.customText);
        if (!normalized) return;
        wizard.variantKind = 'custom';
        wizard.variant = normalized;
        wizard.customText = normalized;
        wizard.step = 'review';
        render();
      });

      document.getElementById('chain').addEventListener('click', function (event) {
        var edit = event.target.closest('[data-edit-variant]');
        if (edit) open('replace', Number(edit.getAttribute('data-edit-variant')), 'variant', true);
      });

      window.__wizardState = function () {
        return JSON.parse(JSON.stringify({ step: wizard ? wizard.step : null, chain: chain }));
      };

      open('replace', 0);
    })();
  </script>
</body>
</html>`;

mkdirSync(new URL('../preview/', import.meta.url), { recursive: true });
writeFileSync(new URL('../preview/wizard.html', import.meta.url), html);
console.log('wrote preview/wizard.html');
