# oMo Slim Preset Selector

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![version](https://img.shields.io/badge/version-1.9.0)](package.json)
[![CI](https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/TauNeutrino/openchamber-omo-slim-preset-selector)](https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector/releases)

An OpenChamber extension that shows the active **oh-my-opencode-slim** preset and switches it — without the TUI and without editing the config by hand.

![Screenshot](assets/screenshot.png)

- Panel on the right rail and a section in the Work Status panel.
- Shows the active preset, its origin (`Global` / `Project`), and the agent→model mapping of the active preset — including fallback chains (`model` arrays), `extends` inheritance and agents that inherit their model.
- **Switches explicitly per scope**: apply a preset globally, or only for the open project — with the file that will be written shown before you confirm.
- Dropdown of every preset, with the orchestrator model as a decision hint.
- Confirmation dialog before every switch; cancelling writes nothing.
- **Preset switching writes only the `preset` key**; the agent and source editors below write only their selected agent block or the validated document. Targeted edits keep comments, ordering and formatting of the JSONC file intact.
- Per-agent editor behind the preset-editing setting: ordered fallback chain with a variant per entry, `inheritModelFrom`, temperature, skills/skills_add/skills_remove, MCPs, permission, display name and color — written to the preset or to the root `agents` map, in either layer.
- **Source editor in the side panel**: the pencil next to the active preset (in the Work Status section and in the panel) opens the rail panel with the raw JSONC of the file that defines the active preset — the project override when it defines it, otherwise the global config. Saves are validated first: invalid JSONC, a non-object root or a missing/broken `presets` map is refused and nothing is written. `Ctrl/Cmd+S` and the Save button go through the same gate; the validation pill shows the position of the first error.
- Checks configured models against the effective model catalog and marks missing ones in red.
- Tracks active and recently finished sessions per agent, with live runtime display.
- Changes to presets and agent definitions take effect for new sessions only after the Managed Service restarts: the saved banner offers **Restart OpenCode**, which asks for confirmation (all running sessions end), stops the managed OpenCode via the contributed service and waits for the model catalog to come back. It works in the web and desktop clients; when OpenCode runs outside OpenChamber, the banner points to a manual restart and falls back to the Settings link.

## Install

Requires OpenChamber 2.3.3 or later.

1. OpenChamber → Settings → Extensions → Add extension.
2. Enter this repository's URL: `https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector.git`
3. Confirm the requested permissions:
   - `filesystem` for the global config
   - `files` for the project override
   - `sessions` for the per-agent session tracking
   - `service` (`exec: opencode`) for the model catalog check
4. Open the **oMo Slim Preset Selector** panel on the right rail.

OpenChamber extensions load in the web and desktop clients and in the mobile app. This extension does not opt in to `panel.mobile`, so the rail panel is available on web and desktop only, while its Work Status section also appears in the mobile app. VS Code does not load OpenChamber extensions.

## Where the config comes from

| Layer | Path |
| --- | --- |
| Global | `~/.config/opencode/oh-my-opencode-slim.json`, else `.jsonc` |
| Project override | `.opencode/oh-my-opencode-slim.json`, else `.jsonc` |

The project map is merged over the global one; the active preset's origin badge shows which layer it comes from.

## Global vs project

Every switch picks a scope:

- **Apply globally** writes `preset` to the global file. It changes the default for every project and does **not** take effect where a project override is set — the panel warns about that before writing and offers to clear the override in the same action.
- **This project only** writes `preset` to `.opencode/oh-my-opencode-slim.json`, creating the file (parent directories included) when the project has none. Any preset name from either layer can be selected there, because the project inherits the global `presets` map.

The active row shows the effective preset plus its origin, and a muted hint when a project override shadows a global preset. The `×` next to it clears the project override (only that key) so the global selection applies again.

## Editing an agent

With **Preset editing** enabled, clicking an agent opens its editor. Two independent choices decide what will be written:

- **preset `<active>`** edits that preset's own agent override; **root agents** edits the `agents.<name>` map, which the plugin applies above the active preset.
- **Global** writes the global config; **This project** writes `.opencode/oh-my-opencode-slim.json` (created when missing).

The form is pre-filled from the chosen destination; when that destination has no block yet, it starts from what runs today so the override can be materialised. The model chain is ordered — first entry is what runs, the rest are fallbacks — and each entry carries its own variant. `Remove` drops the agent from the chosen destination (for a preset that means falling back to the preset inheritance or the built-in default) and asks for a second click.

Status surface note: the editor keeps Advanced collapsed, and the chain and model search scroll inside a capped height.

Preset lists and agent rows reflect the plugin's own resolution: global and project `presets` merge per preset **and per agent**, `presets.<name>.extends` is resolved (with cycle and missing-parent errors reported instead of hiding the panel), and root `agents` overrides are applied above the active preset (marked with a `root` pill).

## Model check

After every load (and then every 15 minutes) the panel checks whether the configured models still exist in the effective catalog. The catalog comes from a small host-managed service that asks `opencode models` (60 s cache, no background load). Missing models are marked red on the agent row and summarized as a warning banner. Unavailable models never crash the switch — the user decides.

## Fallback chains

`model` may be a string or an array of strings and `{ "id", "variant" }` entries, which oh-my-opencode-slim tries in order. The panel shows the primary model plus a `+N` badge for the remaining candidates (`+0` when there is no fallback, so the badge column stays aligned); the tooltip lists the whole chain. Every entry is checked against the catalog. Changing a model from the picker replaces the primary and keeps the other candidates as fallbacks; a model already in the chain is not duplicated. Agents that only set `inheritModelFrom` (`session` / `orchestrator`) are listed with that source instead of a model.

## Sessions per agent

Active sessions show a blue circled count badge; sessions that finished within the last 8 hours show a green squared count badge with a live runtime. Each agent row can be expanded to list its sessions (active first, then finished with outcome and relative time). A finished session can be hidden early with the 👁 button; the hide is reset automatically when the session becomes active again.

## Build

Requires Node.js 22 and npm.

```bash
npm ci
npm run build   # writes panel/main.js and service/main.js
npm run check   # build + IIFE check + manifest check + tests
npm test
npm run type-check
```

The built files are committed: OpenChamber installs the extension as-is and never builds it. After a source change, rebuild and commit `panel/main.js` and `service/main.js`; CI fails when the committed bundles differ from a fresh build.

## Release and update

`version` in `package.json` is the single version source, and the host's update check is driven by it. Versions follow SemVer: patch for fixes, minor for backward-compatible features, major for breaking changes; release candidates use a `-rc.N` suffix.

To release:

1. Bump `version` in `package.json`.
2. Run the full checks locally:
   ```bash
   npm ci
   npm run check
   npm run type-check
   ```
3. Commit `package.json` together with the regenerated `panel/main.js` and `service/main.js`, open a PR and merge it to `main` after CI and review.
4. From `main`, run the release workflow:
   ```bash
   gh workflow run release.yml -f version=1.9.1
   ```
   The workflow validates that the input matches `package.json`, that the tag does not exist, and that the checks pass. It then creates the annotated tag `vX.Y.Z` and a GitHub Release with generated notes (marked prerelease for `-rc.N`). The tag is created by the workflow — do not tag by hand. GitHub Releases are the changelog; there is no `CHANGELOG.md`. See [CONTRIBUTING.md](CONTRIBUTING.md#maintainer-release-runbook) for the maintainer checklist.

### Updating an installed extension

Git-URL installs update from **Settings → Extensions**: OpenChamber checks at most once an hour, and **Check for updates** starts a check immediately. An update keeps the granted permissions and the extension's saved settings; a newly added permission must be approved again. Folder and zip installs do not update themselves — replace the folder or reinstall the zip, then reload OpenChamber.

Append a ref to the Git URL to pin it: `...git#v1.9.0` for a tag or `...git#main` for a branch.

### Rollback and uninstall

To roll back, reinstall from the previous release tag (`...git#v1.8.0`, for example) or point the install at a development folder checkout, then reload OpenChamber. Removing a URL or zip install deletes the installed copy and the extension's host storage; a folder install only forgets the path. This extension stores `presetEditingEnabled`, `finishedWindowHours` and a transient editor-request key there, so removing and re-adding resets them. The JSONC config files the extension edited are never deleted.

## Permissions

| Permission | Why |
| --- | --- |
| `files` | Read/write the project override |
| `filesystem` | Read/write the global config |
| `sessions` | Track sub-sessions per agent |
| `service` (`exec: opencode`) | Run `opencode models` for the catalog check |

Switching writes only the `preset` key. The agent editor writes the selected agent block, and the source editor saves the document you edited after validation. Targeted edits preserve comments, ordering and formatting of the JSONC file.

## License

MIT

## Support

Found a bug or have a question? Open an issue: [github.com/TauNeutrino/openchamber-omo-slim-preset-selector/issues](https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector/issues). Report security problems privately as described in [SECURITY.md](SECURITY.md).

If you find this extension useful, you can support the development:

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate/?hosted_button_id=R5G9H9TFGQNUY)

[![ko-fi](https://storage.ko-fi.com/cdn/kofi5.png?v=6)](https://ko-fi.com/O4O01ZCNJE)
