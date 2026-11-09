import { connectHost, HostRequestError, type GuestProject, type HostReadyContext } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountSpinner,
  type Tone,
} from '@openchamber/sdk/ui';

import {
  addPresetToText,
  applyAgentModelToText,
  applyPresetToText,
  clearPresetFromText,
  orchestratorModel,
  parseConfigText,
  planPresetSwitch,
  primaryModel,
  primaryVariant,
  resolvePresetView,
  sortedPresetNames,
  type ParsedLayer,
  type PresetAgent,
  type PresetSwitchScope,
  type PresetView,
} from './config.ts';
import { countGlyph, groupAgentSessions, rootSessionId, sameDirectory, type AgentSession, type AgentSessionGroups } from './sessions.ts';
import { setLocale, t } from './i18n.ts';
import { auditModelRefs, collectModelRefs, type ModelAudit } from './model-audit.ts';

// The extension can see the global omo-slim config through the manifest's
// filesystem globs. The project override is a relative path, which the host
// joins to the open project under the `files` capability; `ready.directory`
// says whether there is one.
const GLOBAL_PATHS = [
  '~/.config/opencode/oh-my-opencode-slim.json',
  '~/.config/opencode/oh-my-opencode-slim.jsonc',
];
const PROJECT_PATHS = [
  '.opencode/oh-my-opencode-slim.json',
  '.opencode/oh-my-opencode-slim.jsonc',
];
const restartHint = (): string => t('restartHint');

type Notice = { tone: Extract<Tone, 'success' | 'warning' | 'error' | 'info'>; title: string; body?: string };

type ReadyModel = {
  global: ParsedLayer;
  project: ParsedLayer | null;
  view: PresetView;
  directory: string | null;
};

type Screen =
  | { kind: 'loading' }
  | { kind: 'failed'; title: string; detail: string }
  | { kind: 'ready'; model: ReadyModel };

type Interaction =
  | { kind: 'browse' }
  | { kind: 'confirm'; name: string; scope: PresetSwitchScope; clearProjectOverride: boolean }
  | { kind: 'applying'; name: string; scope: PresetSwitchScope }
  | { kind: 'busy' }
  | { kind: 'confirm-kill'; count: number; sessionIds: string[]; parents: string[] }
  | { kind: 'confirm-model-switch'; sessionId: string; model: string; presetName: string };

type LayersRead =
  | { status: 'ready'; global: ParsedLayer; project: ParsedLayer | null }
  | { status: 'failed'; title: string; detail: string };

type FileRead =
  | { kind: 'missing' }
  | { kind: 'file'; raw: string }
  | { kind: 'failed'; message: string };

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('missing #root');

let directory: string | null = null;
let surface: HostReadyContext['surface'] = 'panel';
let screen: Screen = { kind: 'loading' };
let interaction: Interaction = { kind: 'browse' };
let listOpen = false;
let settingsOpen = false;
let noticeDismissTimer: ReturnType<typeof setTimeout> | null = null;
let notice: Notice | null = null;
let loadToken = 0;

const autoDismissNotice = (ms: number): void => {
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  noticeDismissTimer = setTimeout(() => {
    noticeDismissTimer = null;
    if (notice?.tone === 'success') {
      notice = null;
      paint();
    }
  }, ms);
};

const clearNoticeDismissTimer = (): void => {
  if (noticeDismissTimer) {
    clearTimeout(noticeDismissTimer);
    noticeDismissTimer = null;
  }
};
let heightFrame = 0;
let mounted: Array<{ dispose: () => void }> = [];
let agentSessions = new Map<string, AgentSessionGroups>();
/** Finished sessions hidden early (eye button); a new activity on a hidden session clears it. */
const dismissedSessions = new Set<string>();
/** Hours a finished session stays visible. Configurable in the panel's settings section. */
let finishedWindowHours = 8;
let presetEditingEnabled = false;
/** Last session snapshot as delivered by the host, for regrouping when the window changes. */
let lastSessionSnapshot: { records: AgentSession[]; projectId: string; directory: string; sessionId: string | null } | null = null;
/** Model picker state when preset editing is enabled. */
let modelPicker: { agent: string; presetName: string; targetPath: string; currentModel: string; currentVariant: string } | null = null;
let pickerFilter = '';
let pickerAppliedFilter = '';
let pickerDebounce: ReturnType<typeof setTimeout> | 0 = 0;
let modelCatalog: string[] = [];
let modelVariants: Record<string, string[]> = {};
let cloneState: { source: string; scope: 'global' | 'project' | null; name: string } | null = null;

const regroupSessions = (): void => {
  if (!lastSessionSnapshot) return;
  const next = groupAgentSessions(
    lastSessionSnapshot.records, lastSessionSnapshot.projectId, lastSessionSnapshot.directory,
    Date.now(), finishedWindowHours * 60 * 60 * 1000, lastSessionSnapshot.sessionId,
  );
  agentSessions = next;
  if (openAgent !== undefined && !next.has(openAgent)) openAgent = undefined;
};
/** Current OpenCode session, for optional model switching after a preset change. */
let currentSessionId: string | null = null;
let currentSessionTitle: string | null = null;
let currentSessionAgent: string | null = null;
let openAgent: string | undefined;
let sessionsToken = 0;
let projectLookupToken = 0;
let stopProjects: (() => void) | null = null;
let stopSessions: (() => void) | null = null;
let subscribedProject: string | null = null;
let subscriptionToken = 0;

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const errorText = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    switch (error.code) {
      case 'NOT_GRANTED':
        return `${t('accessNotGranted')} (${error.message}).`;
      case 'NO_DIRECTORY':
        return t('noProjectOpen');
      case 'BAD_PATH':
        return `Pfad nicht erlaubt (${error.message}).`;
      case 'FILE_TOO_LARGE':
        return t('fileTooLarge');
      default:
        return `${error.code}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

const readConfigFile = async (path: string): Promise<FileRead> => {
  try {
    const stat = await host.stat(path);
    if (stat.kind === 'missing') return { kind: 'missing' };
    if (stat.kind !== 'file') return { kind: 'failed', message: `${path} ist keine Datei (${stat.kind}).` };
    const { content } = await host.readFile(path);
    return { kind: 'file', raw: content };
  } catch (error) {
    return { kind: 'failed', message: `${path}: ${errorText(error)}` };
  }
};

const readLayer = async (
  kind: 'global' | 'project',
  paths: string[],
): Promise<{ kind: 'loaded'; layer: ParsedLayer } | { kind: 'missing'; path: string } | { kind: 'failed'; path: string; message: string }> => {
  for (const path of paths) {
    const file = await readConfigFile(path);
    if (file.kind === 'missing') continue;
    if (file.kind === 'failed') return { kind: 'failed', path, message: file.message };
    const parsed = parseConfigText(file.raw, path);
    if (!parsed.ok) return { kind: 'failed', path, message: parsed.error };
    return { kind: 'loaded', layer: { kind, path, raw: file.raw, config: parsed.config } };
  }
  return { kind: 'missing', path: paths[0] };
};

const readLayers = async (projectDirectory: string | null): Promise<LayersRead> => {
  const global = await readLayer('global', GLOBAL_PATHS);
  if (global.kind === 'failed') {
    return { status: 'failed', title: t('globalConfigUnreadable'), detail: global.message };
  }
  if (global.kind === 'missing') {
    return {
      status: 'failed',
      title: t('noConfigFound'),
      detail: t('noConfigDetail', GLOBAL_PATHS[0], GLOBAL_PATHS[1]),
    };
  }

  let project: ParsedLayer | null = null;
  if (projectDirectory) {
    const read = await readLayer('project', PROJECT_PATHS);
    if (read.kind === 'failed') {
      return { status: 'failed', title: t('projectOverrideUnreadable'), detail: read.message };
    }
    if (read.kind === 'loaded') project = read.layer;
  }

  return { status: 'ready', global: global.layer, project };
};

const scheduleHeight = (): void => {
  if (surface !== 'status') return;
  if (heightFrame) cancelAnimationFrame(heightFrame);
  heightFrame = requestAnimationFrame(() => {
    heightFrame = 0;
    // Measure the content, not the viewport: a status frame has to be able to
    // shrink after the preset list closes.
    const height = Math.ceil(root.getBoundingClientRect().height);
    if (height > 0) void host.setHeight(height).catch(() => undefined);
  });
};

const clearMounted = (): void => {
  for (const handle of mounted.splice(0)) handle.dispose();
  root.replaceChildren();
};

const paintBanner = (parent: Element, value: Notice): void => {
  mounted.push(mountBanner(parent, {
    tone: value.tone,
    title: value.title,
    body: value.body,
  }));
};

const auditForReadyScreen = (): ModelAudit | null => (modelCheck.kind === 'done' ? modelCheck.audit : null);

const agentRow = (agent: PresetAgent, editable: boolean, onEdit: (agent: PresetAgent) => void): HTMLElement => {
  const key = agent.agent;
  const name = agent.agent;
  const missing = modelIsMissing(auditForReadyScreen(), agent);
  const group = element('div', missing ? 'agent-group is-missing' : 'agent-group');
  const row = element('div', 'agent');
  const sessions = agentSessions.get(key)?.active ?? [];
  const recent = (agentSessions.get(key)?.recent ?? []).filter((entry) => !dismissedSessions.has(entry.id));
  if (sessions.length || recent.length) {
    const trigger = element('button', 'agent-disclosure');
    trigger.type = 'button';
    trigger.dataset.agent = key;
    trigger.setAttribute('aria-expanded', String(openAgent === key));
    const parts = [t('activeSessions', sessions.length)];
    if (recent.length) parts.push(t('recentSessions', recent.length));
    trigger.setAttribute('aria-label', `${name}: ${parts.join(', ')}${parts.length > 1 ? ' (letzte 8 Std)' : ''} — Zum Aufklappen`);
    trigger.append(...[
      sessions.length ? element('span', 'session-count', countGlyph(Math.min(sessions.length, 10)) + (sessions.length > 10 ? '+' : '')) : null,
      recent.length ? element('span', 'session-count is-done', `${Math.min(recent.length, 9)}${recent.length > 9 ? '+' : ''}`) : null,
      element('span', 'agent-name', name),
      element('span', 'agent-chevron', openAgent === key ? '▴' : '▾'),
    ].filter((node): node is HTMLElement => node !== null));
    trigger.addEventListener('click', () => {
      openAgent = openAgent === key ? undefined : key;
      paint();
    });
    row.append(trigger);
  } else {
    row.append(element('span', 'agent-name', name));
  }
  const value = element('span', editable ? 'agent-model is-editable' : 'agent-model');
  if (editable) {
    value.addEventListener('click', () => onEdit(agent));
  }
  const model = element('span', 'model-text');
  const primary = primaryModel(agent);
  if (primary) {
    // Only the model id is shown: the provider prefix did not fit the panel
    // width and truncated the id itself. The full provider/model chain stays
    // in the row's title.
    const slash = primary.lastIndexOf('/');
    model.append(element('span', 'model-content', slash > 0 ? primary.slice(slash + 1) : primary));
  } else {
    // The agent sets no model of its own: it inherits one, or the plugin's
    // default applies. Say so instead of leaving the row blank.
    const label = agent.inheritModelFrom ? t('inheritsFrom', agent.inheritModelFrom) : t('noModelSet');
    model.append(element('span', 'model-content is-inherited', label));
  }
  value.append(model);
  const pills = element('span', 'agent-pills');
  if (agent.models.length > 0) {
    // Always render the count, even at zero: a row without any pill used to
    // start its model text at a different width and broke the pill column.
    const fallbackCount = agent.models.length - 1;
    const fallback = element('span', fallbackCount > 0 ? 'variant fallback-count' : 'variant fallback-count is-zero', `+${fallbackCount}`);
    fallback.title = fallbackCount > 0 ? t('fallbackModels', fallbackCount) : t('noFallbackModels');
    pills.append(fallback);
  }
  const variant = primaryVariant(agent);
  if (variant) {
    const pill = element('span', 'variant');
    pill.append(element('span', 'model-content', variant));
    pills.append(pill);
  }
  if (agent.inheritModelFrom && primary) {
    const inherited = element('span', 'variant', `⇢ ${agent.inheritModelFrom}`);
    inherited.title = t('inheritsFrom', agent.inheritModelFrom);
    pills.append(inherited);
  }
  if (agent.source === 'root') {
    const root = element('span', 'variant', 'root');
    root.title = t('rootOverride');
    pills.append(root);
  }
  if (pills.childElementCount > 0) value.append(pills);
  const chain = agent.models
    .map((ref) => (ref.variant ? `${ref.model} (${ref.variant})` : ref.model))
    .join(' → ');
  value.title = `${agent.agent} · ${chain || (agent.inheritModelFrom ? t('inheritsFrom', agent.inheritModelFrom) : t('noModelSet'))}`
    + (missing ? t('modelNotFoundInCatalog') : '');
  row.append(value);
  group.append(row);
  if ((sessions.length || recent.length) && openAgent === key) {
    const list = element('div', 'session-list');
    list.setAttribute('aria-label', `${name}: ${t('activeAndRecentSessions')}`);
    const dismissTitle = t('hideSession');
    const eyeGlyph = (): HTMLElement => element('span', 'session-hide-glyph', '👁');
    const rows: { session: AgentSession; done: boolean }[] = [
      ...sessions.map((session) => ({ session, done: false })),
      ...recent.map((session) => ({ session, done: true })),
    ];
    for (const { session, done } of rows) {
      const option = element('div', done ? 'session-option is-done' : 'session-option');
      option.dataset.session = session.id;
      const open = element('button', 'session-open');
      open.type = 'button';
      const label = element('span', 'session-title', session.title || t('sessionWithoutTitle'));
      open.title = session.title;
      open.append(label);
      if (done) {
        const outcome = session.outcome === 'completed' ? '✓'
          : session.outcome === 'failed' ? '×' : '';
        const when = relativeTime(session.updatedAt);
        open.append(element('span', 'session-activity', outcome ? `${outcome} ${when}` : when));
      } else {
        const activity = session.activity === 'waiting-permission' ? t('waitingForApproval')
          : session.activity === 'waiting-question' ? t('waitingForAnswer')
            : session.activity === 'retrying' ? t('retrying') : '';
        if (activity) open.append(element('span', 'session-activity', activity));
        const elapsed = element('span', 'session-activity is-live');
        elapsed.dataset.elapsedStart = String(session.createdAt);
        elapsed.textContent = formatDuration(Date.now() - session.createdAt);
        elapsed.title = t('runtimeSinceCreation');
        open.append(elapsed);
      }
      open.addEventListener('click', () => {
        openSession(session.id);
      });
      option.append(open);
      if (done) {
        const hide = element('button', 'session-hide');
        hide.type = 'button';
        hide.title = dismissTitle;
        hide.setAttribute('aria-label', dismissTitle);
        hide.append(eyeGlyph());
        hide.addEventListener('click', (event) => {
          event.stopPropagation();
          dismissedSessions.add(session.id);
          paint();
        });
        option.append(hide);
      }
      list.append(option);
    }
    // Laufzeit-Anzeigen jede Sekunde weiterticken; repaint entsorgt das Intervall.
    const tickElapsed = (): void => {
      const now = Date.now();
      for (const node of list.querySelectorAll<HTMLElement>('.is-live[data-elapsed-start]')) {
        node.textContent = formatDuration(now - Number(node.dataset.elapsedStart ?? '0'));
      }
    };
    const elapsedTimer = setInterval(tickElapsed, 1000);
    mounted.push({ dispose: () => clearInterval(elapsedTimer) });
    group.append(list);
  }
  return group;
};

const relativeTime = (timestamp: number): string => {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return t('justNow');
  if (minutes < 60) return t('minutesAgo', minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('hoursAgo', hours);
  return t('daysAgo', Math.floor(hours / 24));
};

/** Kompakte Laufzeit wie in OpenChamber selbst: 45s, 1m 3s, 2h 15m. */
const formatDuration = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const openSession = (id: string): void => {
  void host.openSession(id).catch((error: unknown) => {
    void host.toast({ kind: 'error', message: `Session konnte nicht geöffnet werden: ${errorText(error)}` }).catch(() => undefined);
  });
};

const defaultScopeFor = (model: ReadyModel, name: string): PresetSwitchScope => {
  if (!directory) return 'global';
  const origin = model.view.origins[name];
  if (origin === 'project' || origin === 'both') return 'project';
  // Stay in the layer that already decides here, instead of silently making a
  // global change the project override would mask.
  if (model.view.projectPreset) return 'project';
  return 'global';
};

const paintPresetList = (parent: Element, model: ReadyModel, busy: boolean): void => {
  const names = sortedPresetNames(model.view.presets);
  const list = element('div', 'preset-list');
  list.id = 'omo-preset-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', t('availablePresets'));

  for (const name of names) {
    const active = name === model.view.active.name;
    const broken = model.view.errors[name];
    const option = element('button', 'preset-option');
    option.type = 'button';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', active ? 'true' : 'false');
    option.dataset.active = active ? 'true' : 'false';
    option.disabled = busy || broken !== undefined;
    if (broken) option.title = broken;

    const label = element('span', 'option-label');
    label.append(element('span', 'option-name', name));
    const hint = orchestratorModel(model.view.effective, name);
    if (hint) label.append(element('span', 'option-model', hint));
    const meta = element('span', 'option-meta');
    if (!active && model.view.active.origin === 'project' && name === model.view.globalPreset) {
      meta.append(element('span', 'option-marker is-global-default', t('globalDefaultMarker')));
    }
    const parentName = model.view.parents[name];
    if (parentName) meta.append(element('span', 'option-extends', `↳ ${parentName}`));
    if (broken) {
      const marker = element('span', 'option-marker', '⚠');
      marker.title = broken;
      meta.append(marker);
    }
    if (meta.childElementCount > 0) label.append(meta);
    option.append(label);

    const origin = model.view.origins[name] ?? 'global';
    const badge = element('span', 'origin-badge', origin === 'both'
      ? t('bothLayers')
      : origin === 'project' ? t('projectLayer') : t('globalLayer'));
    if (origin === 'project') badge.classList.add('is-project');
    if (origin === 'both') badge.classList.add('is-mixed');
    option.append(badge);
    if (active) option.append(element('span', 'option-check', '✓'));
    if (presetEditingEnabled && !broken) {
      const cloneBtn = element('button', 'clone-btn', '🗐');
      cloneBtn.type = 'button';
      cloneBtn.title = t('clonePreset');
      cloneBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        cloneState = { source: name, scope: null, name: '' };
        listOpen = false;
        paint();
      });
      option.append(cloneBtn);
    }
    option.addEventListener('click', () => {
      listOpen = false;
      if (name === model.view.active.name) {
        paint();
        return;
      }
      interaction = {
        kind: 'confirm',
        name,
        scope: defaultScopeFor(model, name),
        clearProjectOverride: false,
      };
      paint();
      const card = root.querySelector<HTMLElement>('.confirm');
      card?.focus();
    });
    list.append(option);
  }

  parent.append(list);
  const active = list.querySelector<HTMLElement>('[data-active="true"]');
  active?.focus();
};

const paintTrigger = (parent: Element, model: ReadyModel, busy: boolean): void => {
  const trigger = element('button', 'preset-trigger');
  trigger.type = 'button';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', listOpen ? 'true' : 'false');
  trigger.setAttribute('aria-controls', 'omo-preset-list');
  trigger.disabled = busy;
  trigger.title = t('switchPreset');
  trigger.append(element('span', 'preset-name', model.view.active.name));
  const scope = element('span', 'scope-control');
  const originBadge = element('span', 'origin-badge', model.view.active.origin === 'project' ? t('projectLayer') : t('globalLayer'));
  originBadge.style.pointerEvents = 'none';
  if (model.view.active.origin === 'project') originBadge.classList.add('is-project');
  scope.append(originBadge);
  if (model.view.projectPreset) {
    const hintText = model.view.globalPreset
      ? (model.view.globalPreset === model.view.active.name
        ? t('sameAsGlobal')
        : t('globalShadowed', model.view.globalPreset))
      : t('noGlobalPreset');
    const hint = element('span', 'scope-hint');
    hint.append(element('span', 'scope-hint-text', hintText));
    if (globalThis.matchMedia?.('(hover: hover)').matches) hint.title = hintText;
    scope.append(hint);
  }
  trigger.append(scope);
  trigger.append(element('span', 'chevron', listOpen ? '▴' : '▾'));
  trigger.addEventListener('click', () => {
    listOpen = !listOpen;
    paint();
  });
  parent.append(trigger);
};

const paintMissingModelsBanner = (panel: HTMLElement, audit: ModelAudit): void => {
  if (audit.missing.length === 0) return;
  const when = audit.checkedAt
    ? new Date(audit.checkedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
    : null;
  const refs = audit.missing.map((entry) => entry.ref).join(', ');
  mounted.push(mountBanner(panel, {
    tone: 'error',
    title: t('missingModelsBannerTitle', audit.missing.length),
    body: refs + (when ? ` — ${t('checkedAt', when)}` : ''),
  }));
};

const modelIsMissing = (audit: ModelAudit | null, agent: PresetAgent): boolean => (
  audit !== null && audit.checkedAt !== null
  && agent.models.some((ref) => audit.missing.some((entry) => entry.ref === ref.model))
);

const paintReady = (panel: HTMLElement, model: ReadyModel): void => {
  const busy = interaction.kind === 'applying' || interaction.kind === 'busy';

  const activeError = model.view.errors[model.view.active.name];
  if (activeError) {
    mounted.push(mountBanner(panel, {
      tone: 'error',
      title: t('presetBrokenTitle', model.view.active.name),
      body: activeError,
    }));
  }

  if (modelCheck.kind === 'done') paintMissingModelsBanner(panel, modelCheck.audit);

  if (interaction.kind === 'confirm-model-switch') {
    const card = element('div', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('orchestratorSessionSwitchTitle'));
    card.append(element('div', 'confirm-title', t('orchestratorSessionSwitchTitle')));
    const body = element('div', 'confirm-body');
    const full = t('orchestratorSessionSwitchBody', interaction.model);
    const idx = full.indexOf(interaction.model);
    if (idx >= 0) {
      body.append(document.createTextNode(full.slice(0, idx)));
      body.append(element('code', '', interaction.model));
      body.append(document.createTextNode(full.slice(idx + interaction.model.length)));
    } else {
      body.append(document.createTextNode(full));
    }
    card.append(body);
    const actions = element('div', 'confirm-actions');
    mounted.push(mountButton(actions, {
      label: t('no'),
      variant: 'ghost',
      size: 'sm',
      onClick: () => {
        interaction = { kind: 'browse' };
        paint();
      },
    }));
    mounted.push(mountButton(actions, {
      label: t('switchModel'),
      size: 'sm',
      onClick: () => {
        const sid = currentSessionId ?? (interaction as Extract<Interaction, { kind: 'confirm-model-switch' }>).sessionId;
        const { model } = interaction as Extract<Interaction, { kind: 'confirm-model-switch' }>;
        void switchSessionModel(sid, model);
      },
    }));
    card.append(actions);
    panel.append(card);
    return;
  }
  if (interaction.kind === 'confirm' || interaction.kind === 'applying') {
    const name = interaction.name;
    const scope: PresetSwitchScope = interaction.scope;
    const projectPath = model.project?.path ?? (directory ? PROJECT_PATHS[0] : null);
    const inGlobal = model.view.globalNames.includes(name);
    const globalDisabled = !inGlobal;
    const projectDisabled = projectPath === null;
    const targetPath = scope === 'project' ? (projectPath ?? PROJECT_PATHS[0]) : model.global.path;

    const card = element('div', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', `${t('apply')} ${name}`);
    card.append(element('div', 'confirm-title', t('applyPresetTitle', name)));
    const body = element('div', 'confirm-body');
    const bodyText = t('applyPresetBody', targetPath);
    const presetIdx = bodyText.indexOf('preset');
    if (presetIdx >= 0) {
      body.append(document.createTextNode(bodyText.slice(0, presetIdx)));
      body.append(element('code', '', 'preset'));
      body.append(document.createTextNode(bodyText.slice(presetIdx + 'preset'.length)));
    } else {
      body.append(document.createTextNode(bodyText));
    }
    card.append(body);

    // Explicit scope: the same preset name is meaningful in both layers, and
    // which one changes is the user's call.
    const scopeRow = element('div', 'confirm-scope');
    const makeChoice = (choice: PresetSwitchScope, label: string, disabled: boolean): HTMLElement => {
      const button = element('button', 'scope-choice', label);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(scope === choice));
      if (scope === choice) button.classList.add('is-selected');
      if (disabled) {
        button.classList.add('is-disabled');
        button.disabled = true;
      }
      button.addEventListener('click', () => {
        if (disabled || interaction.kind === 'applying') return;
        interaction = { kind: 'confirm', name, scope: choice, clearProjectOverride: false };
        paint();
      });
      return button;
    };
    scopeRow.append(makeChoice('global', t('applyGlobally'), globalDisabled));
    scopeRow.append(makeChoice('project', t('applyToProject'), projectDisabled));
    if (globalDisabled) scopeRow.append(element('p', 'confirm-scope-note', t('scopeNotGlobal', name)));
    else if (projectDisabled) scopeRow.append(element('p', 'confirm-scope-note', t('scopeNoProject')));
    card.append(scopeRow);

    const overrideName = model.view.projectPreset;
    if (scope === 'global' && overrideName && overrideName !== name) {
      const warning = element('div', 'confirm-warning');
      warning.append(element('div', 'confirm-warning-text', t('globalOverrideWarning', overrideName)));
      const checkRow = element('label', 'confirm-checkbox-row');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = interaction.kind === 'confirm' && interaction.clearProjectOverride;
      checkbox.disabled = busy || !model.project;
      checkbox.addEventListener('change', () => {
        if (interaction.kind !== 'confirm') return;
        interaction = { ...interaction, clearProjectOverride: checkbox.checked };
      });
      checkRow.append(checkbox, element('span', '', t('alsoClearOverride')));
      warning.append(checkRow);
      card.append(warning);
    }

    card.append(element('div', 'confirm-hint', restartHint()));

    const actions = element('div', 'confirm-actions');
    mounted.push(mountButton(actions, {
      label: t('cancel'),
      variant: 'ghost',
      size: 'sm',
      disabled: busy,
      onClick: () => {
        interaction = { kind: 'browse' };
        paint();
      },
    }));
    mounted.push(mountButton(actions, {
      label: t('apply'),
      size: 'sm',
      loading: busy,
      onClick: () => {
        const clear = interaction.kind === 'confirm' ? interaction.clearProjectOverride : false;
        void applyPreset(name, scope, clear);
      },
    }));
    card.append(actions);
    panel.append(card);
    return;
  }

  const activeRow = element('div', 'active-row');
  paintTrigger(activeRow, model, busy);
  if (model.view.projectPreset) {
    const clear = element('button', 'icon-btn clear-override', '×');
    clear.type = 'button';
    const hint = model.view.globalPreset
      ? t('clearOverrideHint', model.view.globalPreset)
      : t('clearOverride');
    clear.title = hint;
    clear.setAttribute('aria-label', hint);
    clear.disabled = busy;
    clear.addEventListener('click', () => { void clearProjectOverride(); });
    activeRow.append(clear);
  }
  // Refresh (↻) direkt neben dem Preset-Selektor statt einer Eyebrow-Zeile oben.
  const refresh = element('button', 'icon-btn', '↻');
  refresh.type = 'button';
  refresh.title = t('reload');
  refresh.setAttribute('aria-label', t('reload'));
  refresh.disabled = busy;
  refresh.addEventListener('click', () => {
    notice = null;
    void loadAndPaint();
  });
  activeRow.append(refresh);
  const gear = element('button', 'icon-btn settings-btn', '⚙');
  gear.type = 'button';
  gear.title = t('settings');
  gear.setAttribute('aria-label', t('settings'));
  gear.setAttribute('aria-expanded', String(settingsOpen));
  gear.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    paint();
  });
  activeRow.append(gear);
  panel.append(activeRow);

  // Emergency stop, like the plugin's /killall: abort every running subagent of
  // this session and let the orchestrator see a stop notice on its next turn.
  const running = [...agentSessions.values()].flatMap((group) => group.active);
  if (interaction.kind === 'confirm-kill') {
    const count = interaction.count;
    const card = element('div', 'confirm');
    card.tabIndex = -1;
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', t('stopSubagentsTitle', count));
    card.append(element('div', 'confirm-title', t('stopSubagentsTitle', count)));
    card.append(element('div', 'confirm-body', t('stopSubagentsBody', count)));
    const actions = element('div', 'confirm-actions');
    mounted.push(mountButton(actions, {
      label: t('cancel'),
      variant: 'ghost',
      size: 'sm',
      disabled: busy,
      onClick: () => {
        interaction = { kind: 'browse' };
        paint();
      },
    }));
    mounted.push(mountButton(actions, {
      label: t('stopSubagentsConfirm'),
      variant: 'destructive',
      size: 'sm',
      loading: busy,
      onClick: () => {
        const { sessionIds, parents } = interaction as Extract<Interaction, { kind: 'confirm-kill' }>;
        void stopSubagents(sessionIds, parents);
      },
    }));
    card.append(actions);
    panel.append(card);
  } else if (running.length > 0 && !busy) {
    const stop = element('button', 'stop-running');
    stop.type = 'button';
    stop.append(element('span', 'stop-running-label', t('stopSubagents', running.length)));
    stop.addEventListener('click', () => {
      const parent = lastSessionSnapshot
        ? rootSessionId(lastSessionSnapshot.sessionId, lastSessionSnapshot.records)
        : currentSessionId;
      interaction = {
        kind: 'confirm-kill',
        count: running.length,
        sessionIds: running.map((session) => session.id),
        parents: parent ? [parent] : [],
      };
      paint();
    });
    panel.append(stop);
  }

  if (settingsOpen) {
    const box = element('div', 'settings-box');
    const row = element('div', 'setting-row');
    row.append(element('span', 'setting-label', t('finishedSessionsWindow')));
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = '72';
    input.value = String(finishedWindowHours);
    input.className = 'setting-input';
    input.addEventListener('change', () => {
      const v = parseWindowHours(input.value);
      if (v !== null) applyFinishedWindow(v);
    });
    row.append(input);
    box.append(row);

    const editRow = element('div', 'setting-row');
    editRow.append(element('span', 'setting-label', t('presetEditingEnabled')));
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'setting-input';
    checkbox.checked = presetEditingEnabled;
    checkbox.addEventListener('change', () => {
      presetEditingEnabled = checkbox.checked;
      void host.storage.set('presetEditingEnabled', checkbox.checked).catch(() => undefined);
      paint();
    });
    editRow.append(checkbox);
    box.append(editRow);
    panel.append(box);
  }

  if (cloneState) {
    const box = element('div', 'confirm clone-box');
    box.append(element('div', 'confirm-title', t('clonePreset')));
    const body = element('div', 'confirm-body');
    body.append(document.createTextNode(t('cloneSource', cloneState.source)));
    box.append(body);

    if (cloneState.scope === null) {
      const scope = element('div', 'clone-scope');
      const gBtn = element('button', 'clone-scope-btn', t('cloneGlobal'));
      gBtn.type = 'button';
      gBtn.addEventListener('click', () => { if (cloneState) { cloneState.scope = 'global'; paint(); } });
      const pBtn = element('button', 'clone-scope-btn', t('cloneProject'));
      pBtn.type = 'button';
      pBtn.addEventListener('click', () => { if (cloneState) { cloneState.scope = 'project'; paint(); } });
      scope.append(gBtn, pBtn);
      box.append(scope);
    } else {
      const field = element('div', 'clone-field');
      const label = element('label', 'clone-label', t('cloneName'));
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'clone-input';
      input.value = cloneState.name;
      input.placeholder = cloneState.source;
      input.addEventListener('input', () => { if (cloneState) cloneState.name = input.value; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void doClone(model); } });
      field.append(label, input);
      box.append(field);

      const actions = element('div', 'confirm-actions');
      const cancel = element('button', 'confirm-cancel', t('cancel'));
      cancel.type = 'button';
      cancel.addEventListener('click', () => { cloneState = null; paint(); });
      const create = element('button', 'confirm-apply', t('cloneCreate'));
      create.type = 'button';
      create.addEventListener('click', () => { void doClone(model); });
      actions.append(cancel, create);
      box.append(actions);
    }
    panel.append(box);
  }

  if (listOpen) paintPresetList(panel, model, busy);

  if (notice) paintBanner(panel, notice);

  const agents = element('div', 'agents');
  if (model.view.agents.length === 0) {
    agents.append(element('div', 'agents-empty', t('noAgentsConfigured')));
  } else {
    for (const agent of model.view.agents) agents.append(agentRow(agent, presetEditingEnabled, (a) => openModelPicker(a, model)));
  }
  panel.append(agents);

  if (modelPicker) {
    const box = element('div', 'model-picker');
    const head = element('div', 'picker-head');
    head.append(element('span', 'picker-title', `${modelPicker.agent} · ${modelCatalog.length} Modelle`));
    const close = element('button', 'icon-btn', '×');
    close.type = 'button';
    close.title = t('cancel');
    close.addEventListener('click', () => { closeModelPicker(); paint(); });
    head.append(close);
    box.append(head);
    // Unsichtbares Eingabefeld, damit Tastatureingabe zuverlässig erfasst wird
    // (kein sichtbares Input-Feld, nur die Modellliste).
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'text';
    hiddenInput.className = 'picker-hidden-input';
    hiddenInput.value = pickerFilter;
    hiddenInput.setAttribute('aria-hidden', 'true');
    hiddenInput.tabIndex = -1;
    hiddenInput.style.position = 'absolute';
    hiddenInput.style.opacity = '0';
    hiddenInput.style.width = '1px';
    hiddenInput.style.height = '1px';
    hiddenInput.style.border = '0';
    hiddenInput.style.padding = '0';
    hiddenInput.style.pointerEvents = 'none';
    hiddenInput.addEventListener('input', () => {
      pickerFilter = hiddenInput.value;
      if (pickerDebounce) { clearTimeout(pickerDebounce); pickerDebounce = 0; }
      pickerDebounce = setTimeout(() => { pickerAppliedFilter = pickerFilter; paint(); }, 500);
      paint();
    });
    box.append(hiddenInput);
    setTimeout(() => { try { hiddenInput.focus(); } catch {} }, 0);
    if (pickerFilter) {
      box.append(element('div', 'picker-filter', `Filter: ${pickerFilter}`));
    }
    const list = element('div', 'picker-list');
    const filter = pickerAppliedFilter.toLowerCase();
    const items = modelCatalog.filter((m) => !filter || m.toLowerCase().includes(filter));
    if (items.length === 0) {
      const emptyMsg = modelCatalog.length === 0
        ? t('modelCheckLabel')
        : (pickerAppliedFilter ? t('noModelsMatchingFilter') : t('noModelsConfigured'));
      list.append(element('div', 'picker-empty', emptyMsg));
    } else {
      for (const m of items) {
        const row = element('div', 'picker-row');
        const opt = element('button', 'picker-option');
        opt.type = 'button';
        opt.title = m;
        const optText = element('span', 'picker-option-text', m);
        opt.append(optText);
        if (m === modelPicker.currentModel) {
          opt.classList.add('is-current');
          row.classList.add('is-current-row');
        }
        opt.addEventListener('click', () => { void applyPickedModel(m); });
        row.append(opt);
        const reported = modelVariants[m] ?? [];
        const variants = reported.length ? reported : (m.startsWith('opencode/') || m.startsWith('opencode-go/')) ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
        if (variants.length) {
          const vwrap = element('span', 'picker-variants');
          for (const v of variants) {
            const pill = element('button', 'variant-pill', v);
            pill.type = 'button';
            pill.title = `${m} (${v})`;
            if (m === modelPicker.currentModel && v === modelPicker.currentVariant) pill.classList.add('is-active');
            pill.addEventListener('click', (e) => {
              e.stopPropagation();
              void applyPickedModel(m, v);
            });
            vwrap.append(pill);
          }
          row.append(vwrap);
        } else {
          const vinput = document.createElement('input');
          vinput.type = 'text';
          vinput.className = 'variant-input';
          vinput.placeholder = 'variant';
          vinput.title = t('cloneName');
          vinput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              const v = vinput.value.trim();
              void applyPickedModel(m, v);
            }
          });
          row.append(vinput);
        }
        list.append(row);
      }
    }
    box.append(list);
    panel.append(box);
    // Scroll to the currently selected model (center).
    setTimeout(() => {
      const node = list.querySelector('.is-current-row') as HTMLElement | null;
      if (node) node.scrollIntoView({ block: 'center' });
    }, 0);
  }
};

const paintLoading = (panel: HTMLElement): void => {
  const box = element('div', 'loading');
  mounted.push(mountSpinner(box, { label: t('presetsLoading') }));
  panel.append(box);
};

const paintFailed = (panel: HTMLElement, failed: Extract<Screen, { kind: 'failed' }>): void => {
  mounted.push(mountBanner(panel, {
    tone: 'error',
    title: failed.title,
    body: failed.detail,
    action: {
      label: t('reload'),
      onClick: () => {
        notice = null;
        void loadAndPaint();
      },
    },
  }));
  if (notice?.tone === 'success') paintBanner(panel, notice);
};

const paint = (): void => {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedAgent = focused?.dataset.agent;
  const focusedSession = focused?.dataset.session;
  clearMounted();
  const panel = element('div', 'panel');
  if (screen.kind === 'loading') {
    paintLoading(panel);
  } else if (screen.kind === 'failed') {
    paintFailed(panel, screen);
  } else paintReady(panel, screen.model);
  root.append(panel);
  if (focusedAgent) [...root.querySelectorAll<HTMLElement>('.agent-disclosure')].find((item) => item.dataset.agent === focusedAgent)?.focus();
  else if (focusedSession) [...root.querySelectorAll<HTMLElement>('.session-option')].find((item) => item.dataset.session === focusedSession)?.focus();
  scheduleHeight();
};

// Directory changes can race both project lookup and the asynchronous SDK
// subscription handshake. Tokens keep late snapshots and unsubscriptions scoped.
const watchSessions = (currentDirectory: string | null): void => {
  const token = ++sessionsToken;
  ++projectLookupToken;
  stopProjects?.(); stopProjects = null;
  stopSessions?.(); stopSessions = null;
  ++subscriptionToken;
  subscribedProject = null;
  agentSessions = new Map();
  openAgent = undefined;
  if (!currentDirectory) return;

  const selectProject = async (projects: GuestProject[]): Promise<void> => {
    const lookup = ++projectLookupToken;
    let project = projects.find((item) => sameDirectory(item.directory, currentDirectory));
    if (!project) {
      const trees = await Promise.all(projects.map(async (item) => {
        try { return { item, snapshot: await host.listWorktrees(item.id) }; }
        catch { return null; }
      }));
      project = trees.find((result) => result?.snapshot.worktrees.some((tree) => sameDirectory(tree.directory, currentDirectory)))?.item;
    }
    if (token !== sessionsToken || lookup !== projectLookupToken) return;
    const projectId = project?.id ?? null;
    if (projectId === subscribedProject) return;
    stopSessions?.(); stopSessions = null;
    const subscription = ++subscriptionToken;
    subscribedProject = projectId;
    agentSessions = new Map();
    openAgent = undefined;
    paint();
    if (!projectId) return;
    try {
      const unsubscribe = await host.onSessions(projectId, (snapshot) => {
        if (token !== sessionsToken || subscription !== subscriptionToken || subscribedProject !== projectId || snapshot.projectId !== projectId) return;
        const records = snapshot.sessions.filter((session) => session.projectId === projectId);
        lastSessionSnapshot = { records: records as AgentSession[], projectId, directory: currentDirectory, sessionId: currentSessionId };
        const next = groupAgentSessions(records as AgentSession[], projectId, currentDirectory, Date.now(), finishedWindowHours * 60 * 60 * 1000, currentSessionId);
        // Avoid stealing focus on unchanged host updates.
        const signature = (groups: Map<string, AgentSessionGroups>): string => JSON.stringify([...groups].map(([name, entries]) => [
          name,
          entries.active.map((entry) => [entry.id, entry.title, entry.activity]),
          entries.recent.map((entry) => [entry.id, entry.title, entry.activity, entry.updatedAt]),
        ]));
        const unchanged = signature(next) === signature(agentSessions);
        agentSessions = next;
        // Aktivität setzt eine vorzeitige Ausblendung zurück.
        for (const entry of next.values()) for (const active of entry.active) dismissedSessions.delete(active.id);
        if (unchanged) return;
        if (openAgent !== undefined && !next.has(openAgent)) openAgent = undefined;
        // A live update must not reset focus in the preset picker or confirmation.
        // Those views repaint from the latest snapshot when they close.
        if (!listOpen && interaction.kind === 'browse') paint();
      });
      if (token !== sessionsToken || subscription !== subscriptionToken || subscribedProject !== projectId) unsubscribe();
      else stopSessions = unsubscribe;
    } catch {
      if (token === sessionsToken && subscription === subscriptionToken && subscribedProject === projectId) subscribedProject = null;
    }
  };

  let receivedProjects = false;
  void host.onProjects((snapshot) => {
    if (token === sessionsToken && snapshot.state === 'ready') {
      receivedProjects = true;
      void selectProject(snapshot.projects);
    }
  }).then((unsubscribe) => {
    if (token !== sessionsToken) unsubscribe();
    else stopProjects = unsubscribe;
  }).catch(() => undefined);
  void host.listProjects().then((snapshot) => {
    if (token === sessionsToken && !receivedProjects && snapshot.state === 'ready') void selectProject(snapshot.projects);
  }).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Model availability check
//
// The panel asks the package service (contributes.service) for the model
// catalog the effective OpenCode installation reports. Configured references
// missing from the catalog get a red badge and move the first banner to a
// warning, because providers (especially free tiers) retire model ids.

const MODEL_CHECK_RETRY_MS = 15 * 60 * 1000;

type ModelCheck =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string }
  | { kind: 'done'; audit: ModelAudit };

let modelCheck: ModelCheck = { kind: 'checking' };
let modelCheckTimer: ReturnType<typeof setTimeout> | 0 = 0;
let modelCheckRefs: readonly string[] = [];

const scheduleModelCheck = (refs: readonly string[]): void => {
  if (modelCheckTimer) clearTimeout(modelCheckTimer);
  modelCheckTimer = setTimeout(() => {
    modelCheckTimer = 0;
    refreshModelCheck(refs, { background: true });
  }, MODEL_CHECK_RETRY_MS);
};

const refreshModelCheck = (refs: readonly string[], options: { background?: boolean } = {}): void => {
  if (refs.length === 0) {
    modelCheck = { kind: 'done', audit: auditModelRefs([], [], null) };
    if (!options.background) paint();
    return;
  }
  modelCheckRefs = refs;
  if (!options.background) {
    modelCheck = { kind: 'checking' };
    paint();
  }
  void host.serviceRequest({ method: 'GET', path: '/models' })
    .then((result) => {
      if (result.status !== 200) throw new Error(t('serviceHttpError', result.status));
      const answer = JSON.parse(result.body) as { ok?: boolean; catalog?: unknown; checkedAt?: string };
      if (!answer.ok || !Array.isArray(answer.catalog)) throw new Error(t('catalogResponseUnintelligible'));
      const audit = auditModelRefs(refs, answer.catalog as string[], answer.checkedAt ?? null);
      modelCheck = { kind: 'done', audit };
      modelCatalog = answer.catalog as string[];
      modelVariants = (answer as { variants?: Record<string, string[]> }).variants ?? {};
      paint();
      scheduleModelCheck(refs);
    })
    .catch((error: unknown) => {
      if (error instanceof HostRequestError && (error.code === 'NOT_GRANTED' || error.code === 'NO_SERVICE')) {
        modelCheck = { kind: 'unavailable' };
      } else {
        modelCheck = { kind: 'failed', message: errorText(error) };
      }
      paint();
      scheduleModelCheck(refs);
    });
};

const fetchModelCatalog = async (): Promise<void> => {
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/models' });
    if (result.status !== 200) return;
    const answer = JSON.parse(result.body) as { ok?: boolean; catalog?: unknown };
    if (answer.ok && Array.isArray(answer.catalog)) {
      modelCatalog = answer.catalog as string[];
      modelVariants = (answer as { variants?: Record<string, string[]> }).variants ?? {};
      paint();
    }
  } catch {
    // ignore; picker will show "unavailable"
  }
};

const openModelPicker = (agent: PresetAgent, model: ReadyModel): void => {
  const project = model.project;
  const global = model.global;
  const origin = model.view.origins[model.view.active.name] ?? 'global';
  let targetPath = global.path;
  if (project && (origin === 'project' || origin === 'both')) targetPath = project.path;
  modelPicker = {
    agent: agent.agent,
    presetName: model.view.active.name,
    targetPath,
    currentModel: primaryModel(agent) ?? '',
    currentVariant: primaryVariant(agent),
  };
  pickerFilter = '';
  pickerAppliedFilter = '';
  if (pickerDebounce) { clearTimeout(pickerDebounce); pickerDebounce = 0; }
  if (modelCatalog.length === 0) void fetchModelCatalog();
  paint();
};

const closeModelPicker = (): void => {
  modelPicker = null;
  pickerFilter = '';
  pickerAppliedFilter = '';
  if (pickerDebounce) { clearTimeout(pickerDebounce); pickerDebounce = 0; }
};

const applyPickedModel = async (picked: string, variant?: string): Promise<void> => {
  if (!modelPicker) return;
  const { agent, presetName, targetPath } = modelPicker;
  try {
    const file = await readConfigFile(targetPath);
    if (file.kind === 'missing') throw new Error(t('fileNotFound', targetPath));
    if (file.kind === 'failed') throw new Error(file.message);
    const next = applyAgentModelToText(file.raw, presetName, agent, picked, variant ?? '');
    await host.writeFile(targetPath, next);
    closeModelPicker();
    await loadAndPaint();
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(5000);
  }
};
const doClone = async (model: ReadyModel): Promise<void> => {
  if (!cloneState) return;
  const source = cloneState.source;
  const scope = cloneState.scope;
  const trimmed = cloneState.name.trim();
  if (!trimmed || !scope) return;
  const agents = model.view.presets[source] ?? [];
  // Clone the preset's own declaration, not the root overlay; keep `extends`
  // when the parent will be visible in the target layer.
  const parent = model.view.parents[source];
  const visibleParent = parent && (
    scope === 'global'
      ? model.view.globalNames.includes(parent)
      : model.view.globalNames.includes(parent) || model.view.projectNames.includes(parent)
  ) ? parent : null;
  if (agents.length === 0 && !visibleParent) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: t('noAgentsConfigured') };
    paint();
    autoDismissNotice(5000);
    return;
  }
  const targetPath = scope === 'global'
    ? model.global.path
    : (model.project?.path ?? PROJECT_PATHS[0]);
  try {
    const file = await readConfigFile(targetPath);
    const raw = file.kind === 'file' ? file.raw : '';
    const next = addPresetToText(raw, trimmed, agents, visibleParent);
    await host.writeFile(targetPath, next);
    cloneState = null;
    notice = { tone: 'success', title: t('cloneSuccess', trimmed), body: targetPath };
    paint();
    autoDismissNotice(5000);
    await loadAndPaint();
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(5000);
  }
};

const auditRefsFor = (view: PresetView): string[] => collectModelRefs(
  view.agents,
  [view.effective[view.active.name] ?? null],
);

const loadAndPaint = async (): Promise<void> => {
  const token = ++loadToken;
  const currentDirectory = directory;
  interaction = { kind: 'browse' };
  listOpen = false;
  clearNoticeDismissTimer();
  notice = null;
  screen = { kind: 'loading' };
  paint();

  const layers = await readLayers(currentDirectory);
  if (token !== loadToken) return;

  if (layers.status === 'failed') {
    screen = { kind: 'failed', title: layers.title, detail: layers.detail };
    paint();
    return;
  }

  const resolved = resolvePresetView(layers.global, layers.project);
  if (!resolved.ok) {
    screen = { kind: 'failed', title: t('invalidPresetConfig'), detail: resolved.error };
    paint();
    return;
  }

  screen = {
    kind: 'ready',
    model: {
      global: layers.global,
      project: layers.project,
      view: resolved.view,
      directory: currentDirectory,
    },
  };
  paint();
  refreshModelCheck(auditRefsFor(resolved.view));
};

const switchSessionModel = async (sessionId: string, model: string): Promise<void> => {
  const freshId = currentSessionId ?? sessionId;
  interaction = { kind: 'busy' };
  paint();
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/switch-model', body: JSON.stringify({ sessionId: freshId, model }) });
    if (result.status !== 200) throw new Error(`Service antwortete HTTP ${result.status}.`);
    const answer = JSON.parse(result.body) as { ok?: boolean; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? 'Umstellung fehlgeschlagen.');
    // Verify the switch actually landed.
    let verified = model;
    try {
      const check = await host.serviceRequest({ method: 'GET', path: `/models` });
      // best-effort: re-read session via opencode is not available here; trust ok.
    } catch { /* ignore */ }
    interaction = { kind: 'browse' };
    notice = { tone: 'success', title: t('modelSwitched'), body: `${model}${currentSessionTitle ? ` (${currentSessionTitle})` : ''} — wirksam ab nächstem Turn` };
    paint();
    autoDismissNotice(5000);
    void host.toast({ kind: 'success', message: t('switchFailedToast', model) });
  } catch (error) {
    interaction = { kind: 'browse' };
    notice = { tone: 'error', title: t('modelSwitchFailed'), body: errorText(error) || t('modelSwitchFailedDetail') };
    paint();
  }
};

/**
 * Removes the project's `preset` override so the global selection takes effect
 * again. Only that key is touched; the project's own presets stay.
 */
const clearProjectOverride = async (): Promise<void> => {
  const model = screen.kind === 'ready' ? screen.model : null;
  if (!model?.project) return;
  try {
    const file = await readConfigFile(model.project.path);
    if (file.kind !== 'file') throw new Error(t('fileNotFound', model.project.path));
    await host.writeFile(model.project.path, clearPresetFromText(file.raw));
    await loadAndPaint();
    notice = { tone: 'success', title: t('overrideCleared'), body: model.project.path };
    paint();
    autoDismissNotice(5000);
    void host.toast({ kind: 'success', message: t('overrideCleared') });
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(5000);
  }
};

/**
 * Aborts the running subagents of this session and drops the plugin's stop
 * record, so the orchestrator's next turn carries the emergency-stop notice.
 */
const stopSubagents = async (sessionIds: string[], parents: string[]): Promise<void> => {
  if (!directory) return;
  interaction = { kind: 'busy' };
  notice = null;
  paint();
  try {
    const result = await host.serviceRequest({
      method: 'POST',
      path: '/kill-sessions',
      body: JSON.stringify({ sessionIds, parents, directory }),
    });
    if (result.status !== 200) throw new Error(t('serviceHttpError', result.status));
    const answer = JSON.parse(result.body) as { ok?: boolean; aborted?: number; failed?: number; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? t('stopFailed'));
    const aborted = answer.aborted ?? 0;
    const failed = answer.failed ?? 0;
    interaction = { kind: 'browse' };
    notice = {
      tone: failed > 0 ? 'warning' : 'success',
      title: t('subagentsStopped', aborted),
      body: failed > 0 ? t('subagentsStopPartial', failed) : undefined,
    };
    paint();
    autoDismissNotice(6000);
    void host.toast({ kind: 'success', message: t('subagentsStopped', aborted) });
  } catch (error) {
    interaction = { kind: 'browse' };
    const unavailable = error instanceof HostRequestError
      && (error.code === 'NOT_GRANTED' || error.code === 'NO_SERVICE');
    notice = {
      tone: 'error',
      title: t('stopFailed'),
      body: unavailable ? t('stopUnavailable') : errorText(error),
    };
    paint();
    autoDismissNotice(6000);
  }
};

const applyPreset = async (
  name: string,
  scope: PresetSwitchScope,
  clearOverride: boolean,
): Promise<void> => {
  if (interaction.kind === 'applying') return;
  const model = screen.kind === 'ready' ? screen.model : null;
  if (!model) return;

  interaction = { kind: 'applying', name, scope };
  notice = null;
  paint();

  const startDirectory = directory;

  // Re-read before writing: a concurrent edit must not be overwritten with a
  // stale copy.
  const layers = await readLayers(directory);
  if (layers.status === 'failed') {
    interaction = { kind: 'browse' };
    screen = {
      kind: 'failed',
      title: t('presetNotChanged'),
      detail: `${layers.title}: ${layers.detail}`,
    };
    paint();
    return;
  }
  const resolved = resolvePresetView(layers.global, layers.project);
  if (!resolved.ok) {
    interaction = { kind: 'browse' };
    screen = { kind: 'failed', title: t('presetNotChanged'), detail: resolved.error };
    paint();
    return;
  }
  if (directory !== startDirectory) {
    interaction = { kind: 'browse' };
    notice = {
      tone: 'error',
      title: t('presetNotChanged'),
      body: t('projectChanged'),
    };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    return;
  }

  const projectPath = layers.project?.path ?? (directory ? PROJECT_PATHS[0] : null);
  const plan = planPresetSwitch({
    scope,
    name,
    projectPath,
    global: layers.global,
    project: layers.project,
  });
  if (!plan.ok) {
    interaction = { kind: 'browse' };
    notice = { tone: 'error', title: t('presetNotChanged'), body: plan.message };
    screen = { kind: 'ready', model: { ...model, global: layers.global, project: layers.project, view: resolved.view } };
    paint();
    autoDismissNotice(7000);
    return;
  }

  try {
    // A project layer may not have a config file yet; the empty text is the
    // comment-only case, which applyPresetToText turns into a fresh root object.
    const targetLayer = scope === 'project' ? layers.project : layers.global;
    const next = applyPresetToText(targetLayer?.raw ?? '', name);
    await host.writeFile(plan.path, next);
    // Switching globally while the project overrides the preset leaves the
    // project in charge; only clear it when the user asked for that.
    if (scope === 'global' && clearOverride && layers.project?.config.preset) {
      try {
        const projFile = await readConfigFile(layers.project.path);
        if (projFile.kind === 'file') {
          await host.writeFile(layers.project.path, clearPresetFromText(projFile.raw));
        }
      } catch { /* best effort: the global switch landed */ }
    }
    // Neues Orchestrator-Modell aus dem gewählten Preset ermitteln.
    const newOrchestratorModel = orchestratorModel(model.view.effective, name);
    interaction = { kind: 'browse' };
    await loadAndPaint();
    notice = { tone: 'success', title: t('presetSaved', name) };
    paint();
    void host.toast({ kind: 'success', message: `${t('presetSaved', name)} ${restartHint()}` });
    autoDismissNotice(5000);
    // Wenn die aktuelle Session der Orchestrator ist: anbieten, dessen Modell umzustellen.
    if (currentSessionAgent === 'orchestrator' && currentSessionId && newOrchestratorModel) {
      interaction = {
        kind: 'confirm-model-switch',
        sessionId: currentSessionId,
        model: newOrchestratorModel,
        presetName: name,
      };
      paint();
    }
  } catch (error) {
    interaction = { kind: 'browse' };
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    screen = { kind: 'ready', model };
    paint();
  }
};

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (interaction.kind === 'confirm') {
    interaction = { kind: 'browse' };
    paint();
  } else if (listOpen) {
    listOpen = false;
    paint();
  } else if (openAgent !== undefined) {
    openAgent = undefined;
    paint();
  }
});

// A click listener, not pointerdown: closing must not remove the element the
// user just pressed before its own click handler runs.
document.addEventListener('keydown', (event) => {
  if (!modelPicker) return;
  if (event.key === 'Escape') {
    closeModelPicker();
    paint();
    event.preventDefault();
  }
});

// A click listener, not pointerdown: closing must not remove the element the
// user just pressed before its own click handler runs.
document.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (settingsOpen && !target.closest('.settings-box') && !target.closest('.settings-btn')) {
    settingsOpen = false;
    paint();
  }
  if (modelPicker && !target.closest('.model-picker') && !target.closest('.agent-model.is-editable')) {
    closeModelPicker();
    paint();
  }
  if (!listOpen) return;
  if (target.closest('.active-row') || target.closest('.preset-list')) return;
  listOpen = false;
  paint();
});

let didMount = false;

const parseWindowHours = (raw: unknown): number | null => {
  const n = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? raw : NaN;
  return Number.isFinite(n) && n >= 1 && n <= 72 ? n : null;
};

const applyFinishedWindow = (hours: number): void => {
  if (hours === finishedWindowHours) return;
  finishedWindowHours = hours;
  // Persistiert für später; sofortige Wirkung kommt aus dem Regruppieren.
  void host.storage.set('finishedWindowHours', hours).catch(() => undefined);
  if (didMount) {
    regroupSessions();
    if (!listOpen && interaction.kind === 'browse') paint();
  }
};

host.onReady(async (ctx) => {
  applyHostReady(ctx, document.documentElement);
  setLocale(ctx.locale);
  surface = ctx.surface;
  // Bevorzugt die auf der OpenChamber-Settings-Seite gesetzten Werte,
  // sonst der Endpoint-Value aus host.storage (frühere Version).
  const fromSettings = parseWindowHours(ctx.settings?.finishedWindowHours);
  const fromStorage = await host.storage.get('finishedWindowHours').catch(() => undefined);
  const resolved = fromSettings ?? parseWindowHours(fromStorage) ?? 8;
  const editStored = await host.storage.get('presetEditingEnabled').catch(() => undefined);
  if (typeof editStored === 'boolean') presetEditingEnabled = editStored;
  if (!didMount) {
    finishedWindowHours = resolved;
  } else {
    applyFinishedWindow(resolved);
  }
  const nextDirectory = ctx.directory;
  if (!didMount) {
    didMount = true;
    directory = nextDirectory;
    watchSessions(directory);
    void loadAndPaint();
    return;
  }
  if (nextDirectory !== directory) {
    directory = nextDirectory;
    watchSessions(directory);
    void loadAndPaint();
  }
});

host.onSettings((settings) => {
  const hours = parseWindowHours(typeof settings.finishedWindowHours === 'string' || typeof settings.finishedWindowHours === 'number' ? settings.finishedWindowHours : undefined);
  if (hours !== null) applyFinishedWindow(hours);
});

host.onDirectory((next) => {
  if (!didMount || next === directory) return;
  directory = next;
  watchSessions(directory);
  void loadAndPaint();
});

host.onSession((next) => {
  const prev = currentSessionId;
  currentSessionId = next?.id ?? null;
  currentSessionTitle = next?.title ?? null;
  currentSessionAgent = next?.agent ?? null;
  if (didMount && prev !== currentSessionId && lastSessionSnapshot) {
    lastSessionSnapshot.sessionId = currentSessionId;
    regroupSessions();
  }
  if (didMount && !listOpen && interaction.kind === 'browse') paint();
});
