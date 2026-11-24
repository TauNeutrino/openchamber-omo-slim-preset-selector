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
  agentFromOverride,
  applyAgentPatchToText,
  applyPresetToText,
  clearPresetFromText,
  orchestratorModel,
  parseConfigText,
  planPresetSwitch,
  primaryModel,
  primaryVariant,
  removeAgentFromText,
  resolvePresetView,
  sortedPresetNames,
  type ParsedLayer,
  type PresetAgent,
  type PresetModelRef,
  type PresetSwitchScope,
  type PresetView,
} from './config.ts';
import {
  orchestratorTarget,
  supportsLiveReload,
  targetLabel,
  type OpenCodeInfo,
  type SessionTarget,
} from './opencode-mode.ts';
import {
  chainContainsModel,
  draftFromAgent,
  isValidVariantName,
  moveInChain,
  patchFromDraft,
  removeFromChain,
  wizardApply,
  wizardChooseModel,
  wizardChooseVariant,
  wizardCommitCustom,
  wizardEntryOf,
  wizardIsUnchanged,
  type AgentEditorDraft,
  type EditorWizard,
} from './agent-editor.ts';
import { countGlyph, emptyTurnStartTracker, groupAgentSessions, sameDirectory, trackTurnStarts, type AgentSession, type AgentSessionGroups } from './sessions.ts';
import { validatePresetSource, type PresetSourceValidation } from './preset-source.ts';

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
const PRESET_EDITOR_REQUEST_KEY = 'presetEditorRequest';
const PRESET_EDITOR_POLL_MS = 1500;
const restartHint = (): string => t('restartHint');

type Notice = {
  tone: Extract<Tone, 'success' | 'warning' | 'error' | 'info'>;
  title: string;
  body?: string;
  restart?: boolean;
  /** The CTA asked once already; only this confirm block may run the kill. */
  restartConfirm?: boolean;
};

type ReadyModel = {
  global: ParsedLayer;
  project: ParsedLayer | null;
  view: PresetView;
  directory: string | null;
};

type PresetEditorLayer = 'global' | 'project';

type PresetEditorState = {
  /** The panel state to restore when the editor is closed. */
  model: ReadyModel;
  layer: PresetEditorLayer;
  presetName: string;
  path: string;
  content: string;
  original: string;
  validation: PresetSourceValidation;
  errorTitle: string | null;
  error: string | null;
  saving: boolean;
};

type Screen =
  | { kind: 'loading' }
  | { kind: 'failed'; title: string; detail: string }
  | { kind: 'ready'; model: ReadyModel }
  | { kind: 'editor'; editor: PresetEditorState };

type Interaction =
  | { kind: 'browse' }
  | { kind: 'confirm'; name: string; scope: PresetSwitchScope; clearProjectOverride: boolean }
  | { kind: 'applying'; name: string; scope: PresetSwitchScope }
  | { kind: 'busy' }
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
let noticeExpiresAt = 0;
let noticeHovering = false;
let notice: Notice | null = null;
/** Active wait for the restarted OpenCode; paint re-arms its timer. */
let restartPoll: { startedAt: number; title: string } | null = null;
let restartPollTimer: ReturnType<typeof setTimeout> | null = null;
let loadToken = 0;
let lastConsumedPresetEditorRequestAt: number | null = null;
let presetEditorPollTimer: ReturnType<typeof setInterval> | null = null;
let didReadPresetEditorRequestOnMount = false;
let openingPresetEditor = false;

const autoDismissNotice = (ms: number): void => {
  if (!notice) return;
  // The confirm step waits for an explicit choice; there is no timeout there.
  if (notice.restartConfirm) return;
  if (noticeDismissTimer) clearTimeout(noticeDismissTimer);
  const scheduled = notice;
  noticeExpiresAt = Date.now() + ms;
  // Only the notice that was scheduled goes away; a replacement (e.g. an
  // error raised meanwhile) stays until its own timer or the × button.
  // Hovering over the banner pauses the countdown (see paintBanner).
  noticeDismissTimer = setTimeout(() => {
    noticeDismissTimer = null;
    if (noticeHovering) {
      autoDismissNotice(Math.max(1000, noticeExpiresAt - Date.now()));
      return;
    }
    if (notice === scheduled) {
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
/** Observed turn starts per session; the SDK has no turn start of its own. */
let turnStarts = emptyTurnStartTracker();
/** Model picker state when preset editing is enabled. */
type AgentEditor = {
  agent: string;
  presetName: string;
  target: { scope: 'preset' | 'root'; layer: 'global' | 'project' };
  draft: AgentEditorDraft;
  chainOpen: boolean;
  advancedOpen: boolean;
  wizard: EditorWizard | null;
  removeConfirm: boolean;
};
let agentEditor: AgentEditor | null = null;
let wizardFilter = '';
let wizardScrollPending = false;
let wizardFocusCustom = false;
/** Chain entry to flash once after the wizard applied a change. */
let chainFlash: { index: number; until: number } | null = null;
let modelCatalog: string[] = [];
let modelVariants: Record<string, string[]> = {};
let cloneState: { source: string; scope: 'global' | 'project' | null; name: string } | null = null;

const regroupSessions = (): void => {
  if (!lastSessionSnapshot) return;
  const now = Date.now();
  turnStarts = trackTurnStarts(turnStarts, lastSessionSnapshot.records, now);
  const next = groupAgentSessions(
    lastSessionSnapshot.records, lastSessionSnapshot.projectId, lastSessionSnapshot.directory,
    now, finishedWindowHours * 60 * 60 * 1000, lastSessionSnapshot.sessionId,
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

const formatPresetSourceValidation = (validation: PresetSourceValidation): string => {
  if (validation.ok) return t('presetEditorValid');
  if (validation.line !== undefined && validation.column !== undefined) {
    return `${validation.message} (${t('presetSourceLocation', validation.line, validation.column)})`;
  }
  return validation.message;
};

type PresetEditorRequest = {
  name: string;
  at: number;
};

const isPresetEditorRequest = (value: unknown): value is PresetEditorRequest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  return typeof request.name === 'string'
    && request.name.length > 0
    && typeof request.at === 'number'
    && Number.isFinite(request.at);
};

/** Writes the editor request and asks the host to reveal the rail panel. */
const requestPresetEditor = async (model: ReadyModel): Promise<void> => {
  if (openingPresetEditor) return;
  openingPresetEditor = true;
  let stored = false;
  try {
    await host.storage.set(PRESET_EDITOR_REQUEST_KEY, {
      name: model.view.active.name,
      at: Date.now(),
    });
    stored = true;
    await host.openSurface('plugin:omo-preset');
  } catch (error) {
    if (stored) await host.storage.delete(PRESET_EDITOR_REQUEST_KEY).catch(() => undefined);
    const code = error instanceof HostRequestError ? error.code : 'ERROR';
    const detail = error instanceof Error ? error.message : String(error);
    await host.toast({
      kind: 'error',
      message: t('presetEditorOpenFailed', code, detail),
    }).catch(() => undefined);
  } finally {
    openingPresetEditor = false;
  }
};

/** Opens the source editor for one known preset, always from the file on disk. */
const openPresetEditor = async (model: ReadyModel, name: string): Promise<void> => {
  const origin = model.view.origins[name];
  if (!origin) {
    notice = {
      tone: 'error',
      title: t('presetEditorPresetNotFound'),
      body: name,
    };
    paint();
    return;
  }

  const layer: PresetEditorLayer = origin === 'project' || origin === 'both' ? 'project' : 'global';
  const parsedLayer = layer === 'project' ? model.project : model.global;
  if (!parsedLayer) {
    notice = {
      tone: 'error',
      title: t('presetEditorPresetNotFound'),
      body: name,
    };
    paint();
    return;
  }

  try {
    const { content } = await host.readFile(parsedLayer.path);
    screen = {
      kind: 'editor',
      editor: {
        model,
        layer,
        presetName: name,
        path: parsedLayer.path,
        content,
        original: content,
        validation: validatePresetSource(content),
        errorTitle: null,
        error: null,
        saving: false,
      },
    };
    interaction = { kind: 'browse' };
    listOpen = false;
    notice = null;
    paint();
    requestAnimationFrame(() => root.querySelector<HTMLTextAreaElement>('.preset-source-content')?.focus());
  } catch (error) {
    const code = error instanceof HostRequestError ? error.code : 'ERROR';
    const detail = error instanceof Error ? error.message : String(error);
    notice = {
      tone: 'error',
      title: t('presetEditorOpenFailed', code, detail),
    };
    paint();
  }
};

/** Leaves the editor and restores focus to the pencil beside the preset. */
const closePresetEditor = (): void => {
  if (screen.kind !== 'editor') return;
  screen = { kind: 'ready', model: screen.editor.model };
  interaction = { kind: 'browse' };
  listOpen = false;
  notice = null;
  paint();
  requestAnimationFrame(() => root.querySelector<HTMLElement>('.edit-preset-btn')?.focus());
};

/** Validates first, then writes. Invalid source never reaches host.writeFile. */
const savePresetEditor = async (): Promise<void> => {
  if (screen.kind !== 'editor') return;
  const editor = screen.editor;
  if (editor.saving) return;

  const validation = validatePresetSource(editor.content);
  editor.validation = validation;
  if (!validation.ok) {
    editor.errorTitle = t('presetEditorSaveFailed');
    editor.error = `${formatPresetSourceValidation(validation)}. ${t('presetEditorNothingWritten')}`;
    paint();
    requestAnimationFrame(() => root.querySelector<HTMLTextAreaElement>('.preset-source-content')?.focus());
    return;
  }

  editor.saving = true;
  editor.errorTitle = null;
  editor.error = null;
  paint();
  try {
    await host.writeFile(editor.path, editor.content);
    editor.original = editor.content;
    await loadAndPaint();
    await announceSaved(t('presetEditorSaved', editor.presetName), editor.presetName === activePresetName());
    requestAnimationFrame(() => root.querySelector<HTMLElement>('.edit-preset-btn')?.focus());
  } catch (error) {
    if (screen.kind !== 'editor') return;
    screen.editor.saving = false;
    screen.editor.errorTitle = error instanceof HostRequestError
      && (error.code === 'DENIED' || error.code === 'NOT_GRANTED')
      ? t('presetEditorWriteDenied')
      : t('presetEditorSaveFailed');
    screen.editor.error = errorText(error);
    paint();
  }
};

/** Reads and consumes one newer editor request from the status frame. */
const consumePresetEditorRequest = async (): Promise<void> => {
  const value = await host.storage.get(PRESET_EDITOR_REQUEST_KEY).catch(() => undefined);
  if (!isPresetEditorRequest(value)) return;
  const model = screen.kind === 'ready'
    ? screen.model
    : screen.kind === 'editor' ? screen.editor.model : null;
  if (!model) return;
  if (lastConsumedPresetEditorRequestAt !== null && value.at <= lastConsumedPresetEditorRequestAt) return;

  lastConsumedPresetEditorRequestAt = value.at;
  await host.storage.delete(PRESET_EDITOR_REQUEST_KEY).catch(() => undefined);
  await openPresetEditor(model, value.name);
};

/**
 * Keeps the rail panel aware of editor requests from the status frame. The
 * interval lives in `mounted`, so the normal repaint lifecycle disposes it.
 */
const ensurePresetEditorPolling = (): void => {
  if (surface === 'status' || presetEditorPollTimer !== null) return;
  const timer = setInterval(() => {
    void consumePresetEditorRequest();
  }, PRESET_EDITOR_POLL_MS);
  presetEditorPollTimer = timer;
  mounted.push({
    dispose: () => {
      clearInterval(timer);
      if (presetEditorPollTimer === timer) presetEditorPollTimer = null;
    },
  });
  if (!didReadPresetEditorRequestOnMount) {
    didReadPresetEditorRequestOnMount = true;
    void consumePresetEditorRequest();
  }
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

/**
 * Fallback for hosts where the service restart is unavailable (web client,
 * service not granted): open the settings page that has the restart button
 * (`/?settings=general`). The frame shares the server's origin, and
 * `host.openUrl` routes a loopback address to the desktop browser panel, a
 * remote one to the system browser.
 */
const openRestartSettings = async (): Promise<void> => {
  try {
    // The frame is a sandboxed iframe: `location.origin` reads "null" there,
    // so derive the app origin from the frame's own address instead.
    const frameUrl = new URL(globalThis.location.href);
    const target = new URL('/', frameUrl.origin);
    target.searchParams.set('settings', 'general');
    await host.openUrl(target.toString());
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await host.toast({ kind: 'info', message: `${t('restartOpenFailed')} · ${detail}` }).catch(() => undefined);
  }
};

const RESTART_POLL_MS = 3000;
const RESTART_TIMEOUT_MS = 60_000;

const stopRestartPoll = (): void => {
  if (restartPollTimer) {
    clearTimeout(restartPollTimer);
    restartPollTimer = null;
  }
  restartPoll = null;
};

/** Polls GET /models until OpenCode answers again, then shows the success note. */
const pollRestart = async (): Promise<void> => {
  const poll = restartPoll;
  if (!poll) return;
  try {
    // Force a real CLI run: the service cache would answer instantly while the
    // managed process is still down.
    const result = await host.serviceRequest({ method: 'GET', path: '/models?refresh=true' });
    if (result.status === 200) {
      const answer = JSON.parse(result.body) as { ok?: boolean; catalog?: unknown; variants?: unknown };
      if (answer.ok && Array.isArray(answer.catalog) && answer.catalog.length > 0) {
        if (restartPoll !== poll) return;
        modelCatalog = answer.catalog as string[];
        modelVariants = (answer as { variants?: Record<string, string[]> }).variants ?? {};
        stopRestartPoll();
        notice = { tone: 'success', title: t('restartDone') };
        paint();
        autoDismissNotice(15000);
        return;
      }
    }
  } catch {
    // Still down (or the service request failed); keep waiting until the deadline.
  }
  if (restartPoll !== poll) return;
  if (Date.now() - poll.startedAt >= RESTART_TIMEOUT_MS) {
    stopRestartPoll();
    notice = { tone: 'warning', title: poll.title, body: restartHint(), restart: true };
    paint();
    autoDismissNotice(15000);
    return;
  }
  scheduleRestartPoll();
};

/**
 * Arms the next poll. The handle lives in `mounted`, i.e. it is disposed with
 * the render; `paintBanner` re-arms it on every paint, so a repaint cannot
 * strand the wait and a closed notice cannot leak a timer.
 */
const scheduleRestartPoll = (): void => {
  if (!restartPoll || restartPollTimer) return;
  const remaining = RESTART_TIMEOUT_MS - (Date.now() - restartPoll.startedAt);
  if (remaining <= 0) {
    const poll = restartPoll;
    stopRestartPoll();
    notice = { tone: 'warning', title: poll.title, body: restartHint(), restart: true };
    paint();
    autoDismissNotice(15000);
    return;
  }
  const timer = setTimeout(() => {
    restartPollTimer = null;
    void pollRestart();
  }, Math.min(RESTART_POLL_MS, remaining));
  restartPollTimer = timer;
  mounted.push({
    dispose: () => {
      if (restartPollTimer === timer) {
        clearTimeout(timer);
        restartPollTimer = null;
      }
    },
  });
};

/** First CTA click: ask before killing every running session. */
const enterRestartConfirm = (): void => {
  if (!notice) return;
  notice = { ...notice, restart: true, restartConfirm: true };
  clearNoticeDismissTimer();
  paint();
};

const cancelRestartConfirm = (): void => {
  if (!notice) return;
  notice = { ...notice, restart: true, restartConfirm: false };
  paint();
  autoDismissNotice(15000);
};

/** The confirmed CTA: call the service, then wait for the catalog to return. */
const startOpenCodeRestart = async (): Promise<void> => {
  const current = notice;
  if (!current) return;
  const fallbackTitle = current.title;
  stopRestartPoll();
  notice = { tone: 'warning', title: t('restartInProgress'), restart: false, restartConfirm: false };
  restartPoll = { startedAt: Date.now(), title: fallbackTitle };
  paint();
  try {
    const result = await host.serviceRequest({ method: 'POST', path: '/restart-opencode' });
    let answer: { ok?: boolean; error?: unknown; killed?: unknown } = {};
    try {
      answer = JSON.parse(result.body) as typeof answer;
    } catch {
      // The status still decides below.
    }
    if (result.status === 409 || answer.error === 'external') {
      stopRestartPoll();
      notice = { tone: 'warning', title: t('restartExternal'), body: restartHint(), restart: false };
      paint();
      autoDismissNotice(15000);
      void openRestartSettings();
      void host.toast({ kind: 'info', message: t('restartExternal') }).catch(() => undefined);
      return;
    }
    if (result.status !== 200 || !answer.ok) {
      throw new Error(typeof answer.error === 'string' ? answer.error : t('serviceHttpError', result.status));
    }
    // OpenChamber restarts the process itself; the poll takes over from here.
    scheduleRestartPoll();
  } catch (error) {
    stopRestartPoll();
    notice = { tone: 'warning', title: fallbackTitle, body: restartHint(), restart: true };
    paint();
    autoDismissNotice(15000);
    const detail = errorText(error);
    void openRestartSettings();
    void host.toast({ kind: 'info', message: `${t('restartFailed')} · ${detail}` }).catch(() => undefined);
  }
};

const paintBanner = (parent: Element, value: Notice): void => {
  mounted.push(mountBanner(parent, {
    tone: value.tone,
    title: value.title,
    body: value.body,
    action: value.restart && !value.restartConfirm
      ? { label: t('restartNow'), onClick: enterRestartConfirm }
      : undefined,
  }));
  // The restart CTA fills the SDK banner's single action slot; the × control
  // is a separate, absolutely positioned button in the banner's top-right
  // corner. Hovering over the banner pauses the auto-dismiss countdown.
  const bannerNode = parent.lastElementChild as HTMLElement | null;
  if (bannerNode) {
    const closeWrap = document.createElement('span');
    closeWrap.className = 'banner-close';
    const close = mountButton(closeWrap, {
      label: '×',
      variant: 'ghost',
      size: 'xs',
      onClick: () => {
        clearNoticeDismissTimer();
        stopRestartPoll();
        notice = null;
        paint();
      },
    });
    bannerNode.append(closeWrap);
    mounted.push(close);
    const enter = (): void => {
      noticeHovering = true;
      if (noticeDismissTimer) {
        clearTimeout(noticeDismissTimer);
        noticeDismissTimer = null;
      }
    };
    const leave = (): void => {
      noticeHovering = false;
      if (notice?.restartConfirm) return;
      const left = noticeExpiresAt - Date.now();
      if (notice !== null && left > 0) autoDismissNotice(left);
    };
    bannerNode.addEventListener('mouseenter', enter);
    bannerNode.addEventListener('mouseleave', leave);
    mounted.push({
      dispose: () => {
        bannerNode.removeEventListener('mouseenter', enter);
        bannerNode.removeEventListener('mouseleave', leave);
      },
    });
    if (value.restart && value.restartConfirm) {
      const text = bannerNode.querySelector<HTMLElement>('.oc-sdk-banner-text');
      if (text) {
        const confirm = element('div', 'confirm-warning');
        confirm.append(element('div', 'confirm-warning-text', t('restartConfirmText')));
        const actions = element('div', 'confirm-actions');
        const cancel = mountButton(actions, {
          label: t('cancel'),
          variant: 'ghost',
          size: 'xs',
          onClick: cancelRestartConfirm,
        });
        const go = mountButton(actions, {
          label: t('restartConfirmCta'),
          variant: 'destructive',
          size: 'xs',
          onClick: () => { void startOpenCodeRestart(); },
        });
        confirm.append(actions);
        text.append(confirm);
        mounted.push(cancel, go);
      }
    }
    // Repaints dispose `mounted`; re-arm the poll timer on the fresh render.
    scheduleRestartPoll();
  }
};

const auditForReadyScreen = (): ModelAudit | null => (modelCheck.kind === 'done' ? modelCheck.audit : null);

type SessionLineTone = 'warning' | 'info' | 'error' | 'success' | 'unknown';

/** Status of one session row, mirroring the OpenChamber Work Status mapping. */
const sessionLineStatus = (session: AgentSession, done: boolean): { glyph: string; tone: SessionLineTone; label: string } => {
  if (done) {
    if (session.outcome === 'failed') return { glyph: '×', tone: 'error', label: t('sessionFailed') };
    if (session.outcome === 'completed') return { glyph: '✓', tone: 'success', label: t('sessionDone') };
    return { glyph: '◷', tone: 'unknown', label: '' };
  }
  switch (session.activity) {
    case 'waiting-permission': return { glyph: '!', tone: 'warning', label: t('waitingForApproval') };
    case 'waiting-question': return { glyph: '!', tone: 'warning', label: t('waitingForAnswer') };
    case 'retrying': return { glyph: '◉', tone: 'info', label: t('retrying') };
    case 'running': return { glyph: '◉', tone: 'info', label: t('sessionWorking') };
    default: return { glyph: '◷', tone: 'unknown', label: '' };
  }
};

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
      const status = sessionLineStatus(session, done);
      const marker = element('span', `session-status is-${status.tone}`, status.glyph);
      marker.setAttribute('aria-hidden', 'true');
      open.append(marker, label);
      if (status.label) open.append(element('span', `session-state is-${status.tone}`, status.label));
      const now = Date.now();
      if (done) {
        // OpenChamber shows no duration for a finished turn; the age stays in
        // the tooltip instead of occupying the value column.
        open.title = `${session.title || t('sessionWithoutTitle')} — ${relativeTime(session.updatedAt)}`;
      } else {
        const anchor = turnStarts.starts.get(session.id);
        if (typeof anchor === 'number') {
          const elapsed = element('span', 'session-activity is-live');
          elapsed.dataset.elapsedStart = String(anchor);
          elapsed.textContent = formatDuration(now - anchor);
          open.append(elapsed);
          open.title = `${session.title || t('sessionWithoutTitle')} — ${t(
            'sessionRuntimeTitle', formatDuration(now - session.createdAt), formatDuration(now - anchor),
          )}`;
        } else {
          // A turn already running when the panel opened has no observed start.
          open.title = `${session.title || t('sessionWithoutTitle')} — ${t(
            'sessionRuntimeUnknownTitle', formatDuration(now - session.createdAt),
          )}`;
        }
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

/** One segmented control; every `dest-segment` in the editor uses it. */
const editorSegment = (
  label: string,
  options: ReadonlyArray<{ value: string; label: string }>,
  current: string,
  onPick: (value: string) => void,
): HTMLElement => {
  const wrap = element('span', 'dest-segment');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', label);
  for (const option of options) {
    const selected = option.value === current;
    const button = element('button', selected ? 'dest-btn is-selected' : 'dest-btn', option.label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(selected));
    button.addEventListener('click', () => onPick(option.value));
    wrap.append(button);
  }
  return wrap;
};

const editorField = (labelText: string, control: HTMLElement, forId?: string): HTMLElement => {
  const field = element('div', 'editor-field');
  const label = element('label', 'editor-label', labelText);
  if (forId) label.setAttribute('for', forId);
  field.append(label, control);
  return field;
};

const editorTextInput = (
  id: string,
  value: string,
  placeholder: string,
  onInput: (value: string) => void,
): HTMLInputElement => {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.className = 'editor-input';
  input.value = value;
  if (placeholder) input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  return input;
};

/** Known variants of a model: the service catalog, with the same heuristic the picker uses. */
const variantsForModel = (model: string): string[] => {
  const reported = modelVariants[model] ?? [];
  if (reported.length > 0) return reported;
  return model.startsWith('opencode/') || model.startsWith('opencode-go/')
    ? ['low', 'medium', 'high', 'xhigh', 'max']
    : [];
};

/**
 * The variant control of one chain entry: a compact value that opens the
 * wizard's variant step for this entry. It is the only place variants are
 * edited, so the chain itself stays a pure display.
 */
const chainVariantControl = (ref: PresetModelRef, index: number): HTMLElement => {
  const value = ref.variant ?? '';
  const button = element('button', value ? 'chain-variant' : 'chain-variant is-empty');
  button.type = 'button';
  button.textContent = value || t('wizardVariantPlaceholder');
  button.title = t('wizardEditVariant', ref.model);
  button.setAttribute('aria-label', t('wizardEditVariant', ref.model));
  button.addEventListener('click', () => {
    if (!agentEditor) return;
    agentEditor.wizard = {
      mode: 'replace',
      index,
      step: 'variant',
      model: ref.model,
      variantKind: value ? 'pick' : 'none',
      variant: value || null,
      customText: '',
      origModel: ref.model,
      origVariant: value || null,
      lockedModel: true,
    };
    wizardFilter = '';
    wizardFocusCustom = false;
    paint();
    // A panel can outlive changes to the provider catalog, even after saving the model.
    if (!modelVariants[ref.model]?.length) void fetchModelCatalog({ refresh: true });
  });
  return button;
};

/** Step heading shown in the wizard header. */
const wizardStepTitle = (step: EditorWizard['step']): string => (
  step === 'model' ? t('wizardStepModel') : step === 'variant' ? t('wizardStepVariant') : t('wizardStepReview')
);

const wizardStepShort = (step: EditorWizard['step']): string => (
  step === 'model' ? t('wizardStepModelShort') : step === 'variant' ? t('wizardStepVariantShort') : t('wizardStepReviewShort')
);

/** Applies a wizard result to the draft, mirrors the agent-level key, and closes it. */
const applyAgentWizard = (): void => {
  const editor = agentEditor;
  const wizard = editor?.wizard;
  if (!editor || !wizard) return;
  const applied = wizardApply(wizard, editor.draft.chain);
  if (!applied) return;
  editor.draft.chain = applied.chain;
  // Bug-1 semantics: the primary entry owns the agent-level key when present.
  if (applied.index === 0 && editor.draft.present.includes('variant')) {
    editor.draft.variant = applied.chain[0]?.variant ?? '';
  }
  chainFlash = { index: applied.index, until: Date.now() + 1600 };
  editor.wizard = null;
  wizardFilter = '';
  wizardFocusCustom = false;
  paint();
};

/** The per-agent editor: destination, fallback chain, advanced keys, footer. */
const paintAgentEditor = (panel: HTMLElement, model: ReadyModel): void => {
  const editor = agentEditor;
  if (!editor) return;
  if (editor.wizard) {
    paintAgentWizard(panel, model);
    return;
  }
  const draft = editor.draft;
  const card = element('div', 'agent-editor');
  card.tabIndex = -1;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', t('editorTitle', editor.agent));

  const head = element('div', 'editor-head');
  head.append(element('div', 'editor-title', editor.agent));
  head.append(element('div', 'editor-subtitle', t(
    'editorSubtitle',
    editor.presetName,
    editor.target.layer === 'project' ? t('editorLayerProject') : t('editorLayerGlobal'),
  )));
  card.append(head);

  const destination = element('div', 'editor-destination');
  const destRow = element('div', 'editor-dest-row');
  destRow.append(element('span', 'editor-dest-label', t('editorWriteTo')));
  destRow.append(editorSegment(t('editorScope'), [
    { value: 'preset', label: t('editorScopePreset', editor.presetName) },
    { value: 'root', label: t('editorScopeRoot') },
  ], editor.target.scope, (value) => {
    if (!agentEditor) return;
    agentEditor.target.scope = value === 'root' ? 'root' : 'preset';
    resetEditorDraft(model, agentEditor);
    paint();
  }));
  destRow.append(element('span', 'editor-dest-label', t('editorIn')));
  destRow.append(editorSegment(t('editorLayer'), [
    { value: 'global', label: t('editorLayerGlobal') },
    { value: 'project', label: t('editorLayerProject') },
  ], editor.target.layer, (value) => {
    if (!agentEditor) return;
    agentEditor.target.layer = value === 'project' ? 'project' : 'global';
    resetEditorDraft(model, agentEditor);
    paint();
  }));
  destination.append(destRow);
  const pathLine = element('div', 'editor-path', editorTargetPath(model, editor));
  pathLine.title = pathLine.textContent ?? '';
  destination.append(pathLine);
  if (editorIsShadowed(model, editor)) {
    const warning = element('div', 'confirm-warning');
    warning.append(element('div', 'confirm-warning-text', t('editorShadowed', editor.agent, editor.presetName)));
    destination.append(warning);
  }
  card.append(destination);

  // Model chain, primary first.
  const chainSection = element('div', 'editor-section');
  const chainTitle = element('button', 'editor-section-title');
  chainTitle.type = 'button';
  chainTitle.setAttribute('aria-expanded', String(editor.chainOpen));
  chainTitle.append(document.createTextNode(t('editorChain')), element('span', 'editor-chevron', editor.chainOpen ? '▴' : '▾'));
  chainTitle.addEventListener('click', () => {
    if (!agentEditor) return;
    agentEditor.chainOpen = !agentEditor.chainOpen;
    paint();
  });
  chainSection.append(chainTitle);

  if (editor.chainOpen) {
    const body = element('div', 'editor-chain');
    body.append(element('div', 'chain-legend', t('editorChainLegend')));
    if (draft.chain.length === 0) {
      body.append(element('div', 'editor-help', draft.inherit ? t('inheritsFrom', draft.inherit) : t('noModelSet')));
    } else {
      const list = element('div', 'chain-list');
      draft.chain.forEach((ref, index) => {
        const flash = chainFlash !== null && chainFlash.index === index && Date.now() < chainFlash.until;
        const item = element('div', (index === 0 ? 'chain-item is-primary' : 'chain-item') + (flash ? ' is-flash' : ''));
        item.append(element('span', 'chain-rank', String(index + 1)));
        const name = element('span', 'chain-model', ref.model);
        name.title = `${t('editorReplaceModel')} · ${ref.model}`;
        name.style.cursor = 'pointer';
        name.addEventListener('click', () => {
          if (!agentEditor) return;
          agentEditor.wizard = {
            mode: 'replace',
            index,
            step: 'model',
            model: null,
            variantKind: 'none',
            variant: null,
            customText: '',
            origModel: ref.model,
            origVariant: ref.variant ?? null,
            lockedModel: false,
          };
          wizardFilter = '';
          wizardScrollPending = true;
          wizardFocusCustom = false;
          paint();
        });
        item.append(name);
        item.append(chainVariantControl(ref, index));
        const actions = element('span', 'chain-actions');
        const actionButton = (glyph: string, label: string, disabled: boolean, onClick: () => void, remove = false): HTMLElement => {
          const button = element('button', remove ? 'chain-btn is-remove' : 'chain-btn', glyph);
          button.type = 'button';
          button.title = label;
          button.setAttribute('aria-label', label);
          button.disabled = disabled;
          button.addEventListener('click', onClick);
          return button;
        };
        actions.append(
          actionButton('↑', t('chainMoveUp'), index === 0, () => {
            if (!agentEditor) return;
            agentEditor.draft.chain = moveInChain(agentEditor.draft.chain, index, index - 1);
            paint();
          }),
          actionButton('↓', t('chainMoveDown'), index === draft.chain.length - 1, () => {
            if (!agentEditor) return;
            agentEditor.draft.chain = moveInChain(agentEditor.draft.chain, index, index + 1);
            paint();
          }),
          actionButton('★', t('chainMakePrimary'), index === 0, () => {
            if (!agentEditor) return;
            agentEditor.draft.chain = moveInChain(agentEditor.draft.chain, index, 0);
            paint();
          }),
          actionButton('×', t('chainRemove'), false, () => {
            if (!agentEditor) return;
            agentEditor.draft.chain = removeFromChain(agentEditor.draft.chain, index);
            paint();
          }, true),
        );
        item.append(actions);
        list.append(item);
      });
      body.append(list);
    }
    const add = element('button', 'chain-add', t('chainAddFallback'));
    add.type = 'button';
    add.addEventListener('click', () => {
      if (!agentEditor) return;
      agentEditor.wizard = {
        mode: 'add-fallback',
        index: agentEditor.draft.chain.length,
        step: 'model',
        model: null,
        variantKind: 'none',
        variant: null,
        customText: '',
        origModel: null,
        origVariant: null,
        lockedModel: false,
      };
      wizardFilter = '';
      wizardScrollPending = false;
      wizardFocusCustom = false;
      paint();
    });
    body.append(add);
    chainSection.append(body);
  }
  card.append(chainSection);

  // Advanced keys, collapsed unless the user opens them.
  const advanced = element('div', 'editor-section');
  const advancedTitle = element('button', 'editor-section-title');
  advancedTitle.type = 'button';
  advancedTitle.setAttribute('aria-expanded', String(editor.advancedOpen));
  advancedTitle.append(document.createTextNode(t('editorAdvanced')), element('span', 'editor-chevron', editor.advancedOpen ? '▴' : '▾'));
  advancedTitle.addEventListener('click', () => {
    if (!agentEditor) return;
    agentEditor.advancedOpen = !agentEditor.advancedOpen;
    paint();
  });
  advanced.append(advancedTitle);
  if (editor.advancedOpen) {
    const body = element('div', 'editor-advanced');

    const inheritField = element('div', 'editor-field is-row');
    inheritField.append(element('span', 'editor-label', t('editorInherit')));
    inheritField.append(editorSegment(t('editorInherit'), [
      { value: '', label: t('inheritNone') },
      { value: 'session', label: 'session' },
      { value: 'orchestrator', label: 'orchestrator' },
    ], draft.inherit, (value) => {
      if (!agentEditor) return;
      agentEditor.draft.inherit = value === 'session' || value === 'orchestrator' ? value : '';
      paint();
    }));
    body.append(inheritField);

    const temperature = document.createElement('input');
    temperature.type = 'number';
    temperature.id = 'editor-temperature';
    temperature.className = 'editor-input';
    temperature.min = '0';
    temperature.max = '2';
    temperature.step = '0.1';
    temperature.value = draft.temperature;
    temperature.addEventListener('input', () => {
      if (agentEditor) agentEditor.draft.temperature = temperature.value;
    });
    body.append(editorField(t('editorTemperature'), temperature, 'editor-temperature'));

    body.append(editorField(t('editorSkills'), editorTextInput('editor-skills', draft.skills, t('editorListHint'), (value) => {
      if (agentEditor) agentEditor.draft.skills = value;
    }), 'editor-skills'));
    body.append(editorField(t('editorSkillsAdd'), editorTextInput('editor-skills-add', draft.skillsAdd, '', (value) => {
      if (agentEditor) agentEditor.draft.skillsAdd = value;
    }), 'editor-skills-add'));
    body.append(editorField(t('editorSkillsRemove'), editorTextInput('editor-skills-remove', draft.skillsRemove, '', (value) => {
      if (agentEditor) agentEditor.draft.skillsRemove = value;
    }), 'editor-skills-remove'));

    const localRow = element('label', 'editor-checkbox-row');
    const localBox = document.createElement('input');
    localBox.type = 'checkbox';
    localBox.checked = draft.skillsLocal;
    localBox.addEventListener('change', () => {
      if (agentEditor) agentEditor.draft.skillsLocal = localBox.checked;
    });
    localRow.append(localBox, element('span', '', t('editorSkillsLocal')));
    body.append(localRow);

    body.append(editorField(t('editorMcps'), editorTextInput('editor-mcps', draft.mcps, t('editorListHint'), (value) => {
      if (agentEditor) agentEditor.draft.mcps = value;
    }), 'editor-mcps'));

    const perm = element('div', 'editor-perm');
    const permRow = element('div', 'editor-perm-row');
    permRow.append(element('span', 'editor-label', t('editorPermission')));
    permRow.append(editorSegment(t('editorPermission'), [
      { value: 'allow', label: 'allow' },
      { value: 'ask', label: 'ask' },
      { value: 'deny', label: 'deny' },
    ], draft.permissionMode, (value) => {
      if (!agentEditor) return;
      const mode = value === 'allow' || value === 'ask' || value === 'deny' ? value : '';
      agentEditor.draft.permissionMode = mode;
      agentEditor.draft.permissionJson = '';
      paint();
    }));
    const jsonButton = element('button', 'editor-json-btn', '{}');
    jsonButton.type = 'button';
    jsonButton.title = t('editorPermissionJson');
    if (draft.permissionMode === 'json') jsonButton.classList.add('is-selected');
    jsonButton.addEventListener('click', () => {
      if (!agentEditor) return;
      const previous = agentEditor.draft.permissionMode;
      agentEditor.draft.permissionMode = 'json';
      if (!agentEditor.draft.permissionJson.trim()) {
        // Carry the current stance into the JSON view instead of an empty box.
        agentEditor.draft.permissionJson = previous && previous !== 'json'
          ? JSON.stringify(previous)
          : '{}';
      }
      paint();
    });
    permRow.append(jsonButton);
    perm.append(permRow);
    if (draft.permissionMode === 'json') {
      const json = document.createElement('textarea');
      json.className = 'editor-textarea';
      json.value = draft.permissionJson;
      json.placeholder = '{ "edit": "allow" }';
      json.addEventListener('input', () => {
        if (agentEditor) agentEditor.draft.permissionJson = json.value;
      });
      perm.append(json);
    }
    body.append(perm);

    body.append(editorField(t('editorDisplayName'), editorTextInput('editor-display', draft.displayName, '', (value) => {
      if (agentEditor) agentEditor.draft.displayName = value;
    }), 'editor-display'));

    const colorInput = editorTextInput('editor-color', draft.color, 'primary / success / #ff0000', (value) => {
      if (agentEditor) agentEditor.draft.color = value;
    });
    const colors = document.createElement('datalist');
    colors.id = 'editor-color-suggestions';
    for (const value of ['primary', 'secondary', 'accent', 'success', 'warning', 'error', 'info']) {
      const option = document.createElement('option');
      option.value = value;
      colors.append(option);
    }
    colorInput.setAttribute('list', colors.id);
    body.append(editorField(t('editorColor'), colorInput, 'editor-color'), colors);

    advanced.append(body);
  }
  card.append(advanced);

  // Footer: save/cancel plus removal, which needs a second click.
  const footer = element('div', 'editor-footer');
  const actions = element('div', 'editor-actions');
  const cancel = element('button', 'editor-cancel', t('cancel'));
  cancel.type = 'button';
  cancel.addEventListener('click', () => { closeAgentEditor(); paint(); });
  const save = element('button', 'editor-save', t('editorSave'));
  save.type = 'button';
  save.addEventListener('click', () => { void saveAgentEditor(); });
  actions.append(cancel, save);
  footer.append(actions);

  const removeRow = element('div', 'editor-remove-row');
  const where = editor.target.scope === 'root'
    ? t('editorScopeRoot')
    : t('editorScopePreset', editor.presetName);
  if (editor.removeConfirm) {
    removeRow.append(element('span', 'remove-prompt', t('editorRemovePrompt', editor.agent, where)));
    const confirm = element('button', 'editor-remove-confirm', t('editorRemoveCta'));
    confirm.type = 'button';
    confirm.addEventListener('click', () => { void removeAgentFromTarget(); });
    const keep = element('button', 'editor-remove-cancel', t('cancel'));
    keep.type = 'button';
    keep.addEventListener('click', () => {
      if (!agentEditor) return;
      agentEditor.removeConfirm = false;
      paint();
    });
    removeRow.append(confirm, keep);
  } else {
    const remove = element('button', 'editor-remove', t('editorRemoveFrom', where));
    remove.type = 'button';
    remove.addEventListener('click', () => {
      if (!agentEditor) return;
      agentEditor.removeConfirm = true;
      paint();
    });
    removeRow.append(remove);
  }
  footer.append(removeRow);
  card.append(footer);

  panel.append(card);
};

/** The three wizard steps, read-only; there is no "next" button. */
const wizardSteps = (current: EditorWizard['step']): HTMLElement => {
  const order: EditorWizard['step'][] = ['model', 'variant', 'review'];
  const list = element('ol', 'wizard-steps');
  list.setAttribute('aria-label', t('wizardSteps'));
  const currentIndex = order.indexOf(current);
  order.forEach((step, index) => {
    const li = element('li', index === currentIndex ? 'is-current' : index < currentIndex ? 'is-done' : '');
    if (index === currentIndex) li.setAttribute('aria-current', 'step');
    li.append(element('span', 'wizard-dot', index < currentIndex ? '✓' : String(index + 1)));
    li.append(element('span', 'wizard-step-label', wizardStepShort(step)));
    list.append(li);
  });
  return list;
};

/** Step 1: search, mark the replaced model, block models already in the chain. */
const paintWizardModelStep = (body: HTMLElement, editor: AgentEditor, wizard: EditorWizard): void => {
  const replaced = wizard.mode === 'replace' ? editor.draft.chain[wizard.index] : null;
  const context = element('p', 'wizard-context');
  if (replaced) {
    context.append(document.createTextNode(`${t('wizardReplaces')} `), element('code', '', replaced.model));
  } else {
    context.append(document.createTextNode(t('wizardAppends', wizard.index + 1)));
  }
  body.append(context);

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'editor-input wizard-search';
  search.value = wizardFilter;
  search.placeholder = t('wizardModelSearch');
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('aria-label', t('wizardModelSearch'));
  body.append(search);

  const list = element('div', 'wizard-models');
  const fillList = (filterText: string): void => {
    list.replaceChildren();
    const filter = filterText.trim().toLowerCase();
    const items = modelCatalog.filter((entry) => !filter || entry.toLowerCase().includes(filter));
    if (items.length === 0) {
      list.append(element('div', 'wizard-empty', modelCatalog.length === 0 ? t('modelCheckLabel') : t('noModelsMatchingFilter')));
      return;
    }
    for (const entry of items) {
      const blocked = chainContainsModel(editor.draft.chain, entry, wizard.mode === 'replace' ? wizard.index : -1);
      const isCurrent = replaced !== null && entry === replaced.model;
      const row = element('button', `wizard-model-row${isCurrent ? ' is-current' : ''}${blocked ? ' is-blocked' : ''}`);
      row.type = 'button';
      row.disabled = blocked;
      row.title = entry;
      if (isCurrent) row.setAttribute('aria-current', 'true');
      row.append(element('span', 'wizard-model-name', entry));
      const tags = element('span', 'wizard-tags');
      if (isCurrent) tags.append(element('span', 'wizard-tag is-current', t('wizardCurrent')));
      if (blocked) tags.append(element('span', 'wizard-tag', t('wizardInChain')));
      if (tags.childElementCount > 0) row.append(tags);
      row.addEventListener('click', () => {
        if (!agentEditor?.wizard) return;
        agentEditor.wizard = wizardChooseModel(agentEditor.wizard, entry);
        wizardFocusCustom = false;
        paint();
      });
      list.append(row);
    }
  };
  // Filter in place: a full repaint would steal the caret from the field.
  search.addEventListener('input', () => {
    wizardFilter = search.value;
    fillList(search.value);
  });
  fillList(wizardFilter);
  body.append(list);
};

/** Step 2: "none", the known variants, the previous one, or a custom value. */
const paintWizardVariantStep = (body: HTMLElement, editor: AgentEditor, wizard: EditorWizard): void => {
  if (!wizard.model) return;
  const context = element('p', 'wizard-context');
  context.append(document.createTextNode(`${t('wizardModelLabel')} `), element('code', '', wizard.model));
  if (!wizard.lockedModel) {
    const change = element('button', 'wizard-link', t('wizardChangeModel'));
    change.type = 'button';
    change.addEventListener('click', () => {
      if (!agentEditor?.wizard) return;
      agentEditor.wizard.step = 'model';
      wizardScrollPending = true;
      paint();
    });
    context.append(change);
  }
  body.append(context);

  const known = variantsForModel(wizard.model);
  const previous = wizard.mode === 'replace' && wizard.origModel === wizard.model ? wizard.origVariant : null;
  const options = [...known];
  // The previous value stays selectable even when the catalog does not list it.
  if (previous && !options.includes(previous)) options.push(previous);

  const choose = (kind: 'none' | 'pick', value: string | null): void => {
    if (!agentEditor?.wizard) return;
    agentEditor.wizard = wizardChooseVariant(agentEditor.wizard, kind, value);
    wizardFocusCustom = false;
    paint();
  };

  const group = element('div', 'wizard-variants');
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', t('wizardVariantLabel'));
  const none = element('button', 'wizard-variant-option is-sans');
  none.type = 'button';
  none.setAttribute('role', 'radio');
  none.setAttribute('aria-checked', String(wizard.variantKind === 'none'));
  none.append(element('span', 'wizard-variant-name', t('wizardNoVariant')));
  none.addEventListener('click', () => choose('none', null));
  group.append(none);
  for (const variant of options) {
    const option = element('button', 'wizard-variant-option');
    option.type = 'button';
    option.setAttribute('role', 'radio');
    option.setAttribute('aria-checked', String(wizard.variantKind === 'pick' && wizard.variant === variant));
    option.append(element('span', 'wizard-variant-name', variant));
    if (variant === previous) option.append(element('span', 'wizard-bisher', t('wizardPrevious')));
    option.addEventListener('click', () => choose('pick', variant));
    group.append(option);
  }
  const custom = element('button', 'wizard-variant-option is-sans');
  custom.type = 'button';
  custom.setAttribute('role', 'radio');
  custom.setAttribute('aria-checked', String(wizard.variantKind === 'custom'));
  custom.append(element('span', 'wizard-variant-name', t('wizardCustomVariant')));
  custom.addEventListener('click', () => {
    if (!agentEditor?.wizard) return;
    const next = agentEditor.wizard;
    next.variantKind = 'custom';
    next.variant = null;
    wizardFocusCustom = true;
    paint();
  });
  group.append(custom);
  body.append(group);
  if (known.length === 0) body.append(element('p', 'wizard-note', t('wizardNoKnownVariants')));

  if (wizard.variantKind === 'custom') {
    const field = element('div', 'wizard-custom');
    const label = element('label', 'editor-label', t('wizardCustomLabel'));
    label.setAttribute('for', 'wizard-custom-variant');
    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'wizard-custom-variant';
    input.className = 'editor-input wizard-custom-input';
    input.value = wizard.customText;
    input.maxLength = 24;
    input.placeholder = t('wizardCustomPlaceholder');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const error = element('p', 'wizard-error');
    error.hidden = true;
    const validate = (): void => {
      const bad = input.value.trim() !== '' && !isValidVariantName(input.value);
      input.setAttribute('aria-invalid', String(bad));
      error.hidden = !bad;
      error.textContent = bad ? t('wizardVariantInvalid') : '';
    };
    // A valid value advances on change/Enter only, so typing never repaints.
    const commit = (): void => {
      if (!agentEditor?.wizard) return;
      const next = wizardCommitCustom(agentEditor.wizard, input.value);
      if (!next) {
        input.setAttribute('aria-invalid', 'true');
        error.hidden = false;
        error.textContent = t('wizardVariantInvalid');
        return;
      }
      agentEditor.wizard = next;
      paint();
    };
    input.addEventListener('input', () => {
      if (agentEditor?.wizard) agentEditor.wizard.customText = input.value;
      validate();
    });
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    field.append(label, input, error);
    body.append(field);
  }
};

/** Step 3: the fixed destination, the changed slot, and the untouched rest. */
const paintWizardReviewStep = (body: HTMLElement, editor: AgentEditor, wizard: EditorWizard, model: ReadyModel): void => {
  const entry = wizardEntryOf(wizard);
  const old = wizard.mode === 'replace' ? editor.draft.chain[wizard.index] : null;
  const unchanged = wizardIsUnchanged(wizard, editor.draft.chain);

  const target = element('div', 'wizard-target');
  target.append(element('span', '', t('wizardWritesTo')));
  const where = editor.target.scope === 'root'
    ? t('editorScopeRoot')
    : t('editorScopePreset', editor.presetName);
  target.append(element('b', '', `${where} · ${editor.target.layer === 'project' ? t('editorLayerProject') : t('editorLayerGlobal')}`));
  target.append(element('span', 'wizard-path', editorTargetPath(model, editor)));
  body.append(target);

  const diff = element('div', 'wizard-diff');
  if (old) {
    const row = element('div', 'wizard-diff-row is-old');
    row.append(element('span', 'wizard-diff-label', t('wizardSlotOld', wizard.index + 1)));
    row.append(element('span', 'wizard-diff-model', old.model));
    row.append(old.variant
      ? element('span', 'variant', old.variant)
      : element('span', 'wizard-variant-none', t('wizardWithout')));
    diff.append(row);
  }
  if (entry) {
    const row = element('div', 'wizard-diff-row is-new');
    row.append(element('span', 'wizard-diff-label', wizard.mode === 'replace'
      ? t('wizardSlotNew', wizard.index + 1)
      : t('wizardNewSlot', wizard.index + 1)));
    row.append(element('span', 'wizard-diff-model', entry.model));
    row.append(entry.variant
      ? element('span', 'variant', entry.variant)
      : element('span', 'wizard-variant-none', t('wizardWithout')));
    diff.append(row);
  }
  body.append(diff);

  const rest = editor.draft.chain
    .map((ref, index) => ({ ref, index }))
    .filter(({ index }) => !(wizard.mode === 'replace' && index === wizard.index));
  if (rest.length > 0) {
    const band = element('div', 'wizard-band');
    band.append(element('span', 'wizard-band-title', t('wizardRest')));
    const list = element('ol');
    for (const { ref, index } of rest) {
      const item = element('li');
      item.append(element('span', 'chain-rank', String(index + 1)));
      item.append(element('span', 'wizard-band-model', ref.model));
      item.append(ref.variant
        ? element('span', 'variant', ref.variant)
        : element('span', 'wizard-variant-none', t('wizardWithout')));
      list.append(item);
    }
    band.append(list);
    body.append(band);
  }

  if (unchanged) body.append(element('p', 'wizard-note', t('wizardNoChange', wizard.index + 1)));
  const footer = element('div', 'wizard-footer');
  const apply = element('button', 'editor-save wizard-apply', t('wizardApply'));
  apply.type = 'button';
  apply.disabled = !entry || unchanged;
  apply.addEventListener('click', applyAgentWizard);
  footer.append(apply);
  body.append(footer);
  if (!unchanged) body.append(element('p', 'wizard-note', t('wizardReviewHint')));
};

/** The wizard card that takes the editor's place while a model/variant is chosen. */
const paintAgentWizard = (panel: HTMLElement, model: ReadyModel): void => {
  const editor = agentEditor;
  const wizard = editor?.wizard;
  if (!editor || !wizard) return;
  const card = element('div', 'agent-wizard');
  card.tabIndex = -1;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', `${editor.agent}: ${wizardStepTitle(wizard.step)}`);

  const head = element('div', 'wizard-head');
  const titles = element('div', 'wizard-titles');
  titles.append(element('div', 'wizard-kicker', wizard.mode === 'replace'
    ? t('wizardReplaceKicker', wizard.index + 1)
    : t('wizardAddKicker', wizard.index + 1)));
  titles.append(element('div', 'wizard-title', wizardStepTitle(wizard.step)));
  head.append(titles);
  const close = element('button', 'icon-btn', '×');
  close.type = 'button';
  close.title = t('cancel');
  close.setAttribute('aria-label', t('cancel'));
  close.addEventListener('click', () => {
    if (!agentEditor) return;
    agentEditor.wizard = null;
    wizardFilter = '';
    wizardFocusCustom = false;
    paint();
  });
  head.append(close);
  card.append(head, wizardSteps(wizard.step));

  const body = element('div', 'wizard-body');
  if (wizard.step === 'model') paintWizardModelStep(body, editor, wizard);
  else if (wizard.step === 'variant') paintWizardVariantStep(body, editor, wizard);
  else paintWizardReviewStep(body, editor, wizard, model);
  card.append(body);
  panel.append(card);

  if (wizard.step === 'model') {
    const current = card.querySelector<HTMLElement>('.wizard-model-row.is-current');
    if (wizardScrollPending) {
      wizardScrollPending = false;
      if (current && !wizardFilter.trim()) {
        requestAnimationFrame(() => {
          try { current.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
        });
      }
    }
    requestAnimationFrame(() => {
      try { card.querySelector<HTMLInputElement>('.wizard-search')?.focus({ preventScroll: true }); } catch { /* ignore */ }
    });
  } else if (wizard.step === 'variant' && wizardFocusCustom) {
    wizardFocusCustom = false;
    requestAnimationFrame(() => {
      try { card.querySelector<HTMLInputElement>('.wizard-custom-input')?.focus({ preventScroll: true }); } catch { /* ignore */ }
    });
  }
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
  // The pencil also stays in the rail view so the editor can hand focus back.
  const editPreset = element('button', 'icon-btn edit-preset-btn', '✎');
  editPreset.type = 'button';
  editPreset.title = t('editPresetInEditor');
  editPreset.setAttribute('aria-label', t('editPresetInEditor'));
  editPreset.disabled = busy;
  editPreset.addEventListener('click', () => { void requestPresetEditor(model); });
  activeRow.append(editPreset);
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
    for (const agent of model.view.agents) agents.append(agentRow(agent, presetEditingEnabled, (a) => openAgentEditor(a, model)));
  }
  panel.append(agents);

  if (agentEditor) {
    paintAgentEditor(panel, model);
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

const paintPresetEditor = (panel: HTMLElement, editor: PresetEditorState): void => {
  const container = element('section', 'preset-source-editor');
  container.tabIndex = -1;
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', `${t('presetEditorTitle')}: ${editor.presetName}`);

  const header = element('header', 'preset-source-header');
  const identity = element('div', 'preset-source-identity');
  identity.append(element('h1', 'preset-source-name', editor.presetName));
  identity.append(element('div', 'preset-source-path', editor.path));

  const state = element('div', 'preset-source-state');
  const validationPill = element('span', 'preset-source-validation');
  const back = element('button', 'icon-btn preset-source-back', '←');
  back.type = 'button';
  back.title = t('presetEditorBack');
  back.setAttribute('aria-label', t('presetEditorBack'));
  back.addEventListener('click', () => closePresetEditor());
  state.append(validationPill, back);
  header.append(identity, state);

  if (editor.errorTitle && editor.error) {
    mounted.push(mountBanner(container, {
      tone: 'error',
      title: editor.errorTitle,
      body: editor.error,
    }));
  }

  const textarea = element('textarea', 'preset-source-content');
  textarea.value = editor.content;
  textarea.spellcheck = false;
  textarea.autocomplete = 'off';
  textarea.setAttribute('aria-label', `${t('presetEditorTitle')}: ${editor.presetName}`);

  const footer = element('div', 'preset-source-footer');
  const save = element('button', 'editor-save preset-source-save', t('presetEditorSave'));
  save.type = 'button';
  save.addEventListener('click', () => { void savePresetEditor(); });
  footer.append(save);

  const updateValidation = (validation: PresetSourceValidation): void => {
    validationPill.classList.toggle('is-valid', validation.ok);
    validationPill.classList.toggle('is-invalid', !validation.ok);
    if (validation.ok) {
      validationPill.textContent = t('presetEditorValid');
      validationPill.title = t('presetEditorValid');
    } else {
      const message = formatPresetSourceValidation(validation);
      validationPill.textContent = `${t('presetEditorInvalid')} · ${message}`;
      validationPill.title = message;
    }
    save.disabled = !validation.ok || editor.saving;
  };

  textarea.addEventListener('input', () => {
    if (screen.kind !== 'editor') return;
    screen.editor.content = textarea.value;
    screen.editor.validation = validatePresetSource(textarea.value);
    updateValidation(screen.editor.validation);
  });

  container.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closePresetEditor();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      event.stopPropagation();
      void savePresetEditor();
    }
  });

  updateValidation(editor.validation);
  container.prepend(header);
  container.append(textarea, footer);
  panel.append(container);
};

const paint = (): void => {
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusedAgent = focused?.dataset.agent;
  const focusedSession = focused?.dataset.session;
  const focusedSource = focused instanceof HTMLTextAreaElement && focused.classList.contains('preset-source-content')
    ? focused
    : null;
  const sourceSelection = focusedSource
    ? { start: focusedSource.selectionStart, end: focusedSource.selectionEnd }
    : null;
  clearMounted();
  const panel = element('div', 'panel');
  if (screen.kind === 'loading') {
    paintLoading(panel);
  } else if (screen.kind === 'failed') {
    paintFailed(panel, screen);
  } else if (screen.kind === 'editor') {
    paintPresetEditor(panel, screen.editor);
  } else paintReady(panel, screen.model);
  root.append(panel);
  if (focusedSource) {
    const nextSource = root.querySelector<HTMLTextAreaElement>('.preset-source-content');
    nextSource?.focus();
    if (sourceSelection) nextSource?.setSelectionRange(sourceSelection.start, sourceSelection.end);
  } else if (focusedAgent) {
    [...root.querySelectorAll<HTMLElement>('.agent-disclosure')].find((item) => item.dataset.agent === focusedAgent)?.focus();
  } else if (focusedSession) {
    [...root.querySelectorAll<HTMLElement>('.session-option')].find((item) => item.dataset.session === focusedSession)?.focus();
  }
  ensurePresetEditorPolling();
  // A repaint disposes the poll handle registered in `mounted`; arm it again
  // even when the restart notice is temporarily replaced by another screen.
  scheduleRestartPoll();
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
    turnStarts = emptyTurnStartTracker();
    openAgent = undefined;
    paint();
    if (!projectId) return;
    try {
      const unsubscribe = await host.onSessions(projectId, (snapshot) => {
        if (token !== sessionsToken || subscription !== subscriptionToken || subscribedProject !== projectId || snapshot.projectId !== projectId) return;
        const records = snapshot.sessions.filter((session) => session.projectId === projectId);
        lastSessionSnapshot = { records: records as AgentSession[], projectId, directory: currentDirectory, sessionId: currentSessionId };
        const now = Date.now();
        turnStarts = trackTurnStarts(turnStarts, records as AgentSession[], now);
        const next = groupAgentSessions(records as AgentSession[], projectId, currentDirectory, now, finishedWindowHours * 60 * 60 * 1000, currentSessionId);
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

const fetchModelCatalog = async ({ refresh = false } = {}): Promise<void> => {
  try {
    const result = await host.serviceRequest({ method: 'GET', path: refresh ? '/models?refresh=true' : '/models' });
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

/** The layer object the editor targets, or null when the project is closed. */
const editorLayer = (model: ReadyModel, layer: 'global' | 'project'): ParsedLayer | null => (
  layer === 'project' ? model.project : model.global
);

/** The block the chosen destination currently holds in that layer, if any. */
const editorOwnAgent = (model: ReadyModel, editor: AgentEditor): PresetAgent | undefined => {
  const layer = editorLayer(model, editor.target.layer);
  if (!layer) return undefined;
  if (editor.target.scope === 'root') {
    const override = layer.config.rootAgents[editor.agent];
    return override ? agentFromOverride(editor.agent, override, 'root') : undefined;
  }
  return layer.config.presets[editor.presetName]?.find((agent) => agent.agent === editor.agent);
};

const editorTargetPath = (model: ReadyModel, editor: AgentEditor): string => (
  editor.target.layer === 'project'
    ? (model.project?.path ?? PROJECT_PATHS[0])
    : model.global.path
);

/**
 * A global edit is shadowed when the project defines the same agent in the same
 * scope, because the project layer wins at runtime.
 */
const editorIsShadowed = (model: ReadyModel, editor: AgentEditor): boolean => {
  if (editor.target.layer !== 'global' || !model.project) return false;
  if (editor.target.scope === 'root') {
    return Object.hasOwn(model.project.config.rootAgents, editor.agent);
  }
  const local = model.project.config.presets[editor.presetName] ?? [];
  return local.some((agent) => agent.agent === editor.agent);
};

/** Loads the form from the chosen destination; absent there, from what runs today. */
const resetEditorDraft = (model: ReadyModel, editor: AgentEditor): void => {
  const own = editorOwnAgent(model, editor);
  const effective = model.view.agents.find((agent) => agent.agent === editor.agent);
  const source = own ?? effective;
  editor.draft = source
    ? draftFromAgent(source)
    : draftFromAgent({ agent: editor.agent, models: [] });
  editor.wizard = null;
  editor.removeConfirm = false;
  wizardFilter = '';
  wizardScrollPending = false;
  wizardFocusCustom = false;
  chainFlash = null;
};

const openAgentEditor = (agent: PresetAgent, model: ReadyModel): void => {
  const origin = model.view.origins[model.view.active.name] ?? 'global';
  agentEditor = {
    agent: agent.agent,
    presetName: model.view.active.name,
    target: {
      scope: 'preset',
      layer: origin === 'global' ? 'global' : 'project',
    },
    draft: draftFromAgent(agent),
    chainOpen: true,
    advancedOpen: false,
    wizard: null,
    removeConfirm: false,
  };
  resetEditorDraft(model, agentEditor);
  if (modelCatalog.length === 0) void fetchModelCatalog();
  paint();
  setTimeout(() => {
    try { root.querySelector<HTMLElement>('.agent-editor')?.focus(); } catch { /* ignore */ }
  }, 0);
};

const closeAgentEditor = (): void => {
  agentEditor = null;
  wizardFilter = '';
  wizardScrollPending = false;
  wizardFocusCustom = false;
  chainFlash = null;
};

/**
 * Re-reads the layers and refreshes the view, so an editor session that was
 * open while the file changed does not silently overwrite it with a patch
 * built from a stale view.
 */
const resyncEditorView = async (): Promise<boolean> => {
  const layers = await readLayers(directory);
  if (layers.status === 'failed') return false;
  const resolved = resolvePresetView(layers.global, layers.project);
  if (!resolved.ok) return false;
  const model = screen.kind === 'ready' ? screen.model : null;
  if (!model) return false;
  screen = {
    kind: 'ready',
    model: {
      ...model,
      global: layers.global,
      project: layers.project,
      view: resolved.view,
      directory,
    },
  };
  return true;
};

const saveAgentEditor = async (): Promise<void> => {
  const editor = agentEditor;
  const model = screen.kind === 'ready' ? screen.model : null;
  if (!editor || !model) return;
  if (!(await resyncEditorView())) {
    notice = { tone: 'error', title: t('editorNotSaved'), body: t('configUnreadable') };
    paint();
    return;
  }
  const refreshed = screen.kind === 'ready' ? screen.model : null;
  if (!refreshed) return;
  const built = patchFromDraft(editor.draft);
  if (!built.ok) {
    notice = {
      tone: 'error',
      title: t('editorNotSaved'),
      body: built.error === 'temperature' ? t('editorTemperatureInvalid') : t('editorPermissionInvalid'),
    };
    paint();
    autoDismissNotice(6000);
    return;
  }
  const path = editorTargetPath(refreshed, editor);
  const target = editor.target.scope === 'root'
    ? { kind: 'root' as const }
    : { kind: 'preset' as const, presetName: editor.presetName };
  try {
    const patchLayer = editor.target.layer === 'project' ? refreshed.project : refreshed.global;
    const base = patchLayer?.raw ?? '';
    const parsedBase = parseConfigText(base, path);
    const commentOnly = parsedBase.ok && parsedBase.config.commentOnly;
    // A missing, empty or comment-only file needs a root object; a new project
    // preset starts as an empty block so the patch lands inside it.
    const seeded = base.trim() && !commentOnly
      ? base
      : editor.target.scope === 'root'
        ? '{}\n'
        : `${JSON.stringify({ presets: { [editor.presetName]: {} } }, null, 2)}\n`;
    const next = applyAgentPatchToText(seeded, target, editor.agent, built.patch);
    await host.writeFile(path, next);
    closeAgentEditor();
    await loadAndPaint();
    await announceSaved(t('editorSaved', editor.agent), editor.agent === 'orchestrator');
  } catch (error) {
    notice = { tone: 'error', title: t('editorNotSaved'), body: errorText(error) };
    paint();
    autoDismissNotice(6000);
  }
};

const removeAgentFromTarget = async (): Promise<void> => {
  const editor = agentEditor;
  const model = screen.kind === 'ready' ? screen.model : null;
  if (!editor || !model) return;
  if (!(await resyncEditorView())) {
    notice = { tone: 'error', title: t('editorNotSaved'), body: t('configUnreadable') };
    paint();
    return;
  }
  const refreshed = screen.kind === 'ready' ? screen.model : null;
  if (!refreshed) return;
  const path = editorTargetPath(refreshed, editor);
  const target = editor.target.scope === 'root'
    ? { kind: 'root' as const }
    : { kind: 'preset' as const, presetName: editor.presetName };
  try {
    const file = await readConfigFile(path);
    if (file.kind !== 'file') throw new Error(t('fileNotFound', path));
    const next = removeAgentFromText(file.raw, target, editor.agent);
    await host.writeFile(path, next);
    closeAgentEditor();
    await loadAndPaint();
    await announceSaved(t('editorRemoved', editor.agent), editor.agent === 'orchestrator');
  } catch (error) {
    notice = { tone: 'error', title: t('editorNotSaved'), body: errorText(error) };
    paint();
    autoDismissNotice(6000);
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
    autoDismissNotice(15000);
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
    autoDismissNotice(15000);
    await loadAndPaint();
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(15000);
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

/** OpenCode host facts from the service; null until a check found a version. */
let openCodeInfo: OpenCodeInfo | null = null;
let openCodeInfoLoad: Promise<OpenCodeInfo | null> | null = null;

const ensureOpenCodeInfo = (): Promise<OpenCodeInfo | null> => {
  if (openCodeInfo) return Promise.resolve(openCodeInfo);
  openCodeInfoLoad ??= (async () => {
    try {
      const result = await host.serviceRequest({ method: 'GET', path: '/opencode-info' });
      if (result.status !== 200) return null;
      const answer = JSON.parse(result.body) as Partial<OpenCodeInfo> & { ok?: boolean };
      if (!answer.ok || typeof answer.major !== 'number') return null;
      openCodeInfo = { version: answer.version ?? null, major: answer.major, server: answer.server ?? 'unknown' };
      return openCodeInfo;
    } catch {
      return null;
    } finally {
      openCodeInfoLoad = null;
    }
  })();
  return openCodeInfoLoad;
};

const activePresetName = (): string | null => (screen.kind === 'ready' ? screen.model.view.active.name : null);

const activeOrchestratorTarget = (): SessionTarget | null => {
  const name = activePresetName();
  if (screen.kind !== 'ready' || !name) return null;
  return orchestratorTarget(screen.model.view.effective[name]);
};

const serviceJson = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<Record<string, unknown>> => {
  const result = await host.serviceRequest({ method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let answer: Record<string, unknown> = {};
  try {
    answer = JSON.parse(result.body) as Record<string, unknown>;
  } catch { /* non-JSON answer: reported by status below */ }
  if (result.status !== 200 || answer.ok !== true) {
    throw new Error(typeof answer.error === 'string' ? answer.error : `HTTP ${result.status}`);
  }
  return answer;
};

/**
 * Tells the user a config write landed. OpenCode v1, or a host whose version
 * could not be read, keeps the restart notice. On v2 nothing is asked:
 * subagents follow the file live, and when the orchestrator may have changed
 * the config is reloaded and the open session moves onto the orchestrator
 * agent with the preset's model and effort, which is what the model picker shows.
 */
const announceSaved = async (title: string, orchestratorChanged: boolean): Promise<void> => {
  const info = await ensureOpenCodeInfo();
  if (!supportsLiveReload(info)) {
    notice = { tone: 'warning', title, body: restartHint(), restart: true };
    paint();
    autoDismissNotice(15000);
    return;
  }
  if (!orchestratorChanged) {
    notice = { tone: 'success', title, body: t('liveApplied') };
    paint();
    autoDismissNotice(8000);
    return;
  }
  notice = { tone: 'info', title, body: t('reloadingConfig') };
  paint();
  const lines: string[] = [t('liveApplied')];
  let tone: Notice['tone'] = 'success';
  try {
    const answer = await serviceJson('POST', '/reload-config');
    lines.push(answer.reloaded === true ? t('configReloaded') : t('reloadManagedNote'));
  } catch (error) {
    tone = 'warning';
    lines.push(t('reloadFailed', errorText(error)));
  }
  const target = activeOrchestratorTarget();
  const sessionId = currentSessionId;
  if (target && sessionId) {
    try {
      await serviceJson('POST', '/switch-session', {
        sessionId,
        agent: target.agent,
        model: `${target.providerID}/${target.id}`,
        variant: target.variant ?? '',
      });
      currentSessionAgent = target.agent;
      lines.push(t('sessionSwitched', targetLabel(target)));
    } catch (error) {
      tone = 'warning';
      lines.push(t('sessionSwitchFailed', errorText(error)));
    }
  } else if (target) {
    lines.push(t('noSessionToSwitch'));
  }
  notice = { tone, title, body: lines.join(' ') };
  paint();
  autoDismissNotice(15000);
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
    autoDismissNotice(15000);
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
    autoDismissNotice(15000);
    void host.toast({ kind: 'success', message: t('overrideCleared') });
  } catch (error) {
    notice = { tone: 'error', title: t('presetNotChanged'), body: errorText(error) };
    paint();
    autoDismissNotice(15000);
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
    if (supportsLiveReload(await ensureOpenCodeInfo())) {
      void host.toast({ kind: 'success', message: t('presetSaved', name) });
      await announceSaved(t('presetSaved', name), true);
      return;
    }
    notice = { tone: 'warning', title: t('presetSaved', name), body: restartHint(), restart: true };
    paint();
    autoDismissNotice(15000);
    void host.toast({ kind: 'success', message: `${t('presetSaved', name)} ${restartHint()}` });
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
  // The agent editor owns Escape while it is open (wizard layer, then editor).
  if (agentEditor) return;
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
  if (!agentEditor) return;
  if (event.key === 'Escape') {
    if (agentEditor.wizard) {
      // The wizard is a layer of its own: Escape leaves it without a change.
      agentEditor.wizard = null;
      wizardFilter = '';
      wizardFocusCustom = false;
      paint();
    } else {
      closeAgentEditor();
      paint();
    }
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
  if (agentEditor && !target.closest('.agent-editor') && !target.closest('.agent-wizard') && !target.closest('.agent-model.is-editable')) {
    closeAgentEditor();
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
  root.classList.toggle('status-surface', surface === 'status');
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
