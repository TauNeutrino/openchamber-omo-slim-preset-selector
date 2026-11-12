# oMo Slim Preset Selector

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![version](https://img.shields.io/badge/version-1.6.2)](package.json)

An OpenChamber extension that shows the active **oh-my-opencode-slim** preset and switches it — without the TUI and without editing the config by hand.

![Screenshot](assets/screenshot.png)

- Panel on the right rail and a section in the Work Status panel.
- Shows the active preset, its origin (`Global` / `Project`), and the agent→model mapping of the active preset — including fallback chains (`model` arrays), `extends` inheritance and agents that inherit their model.
- **Switches explicitly per scope**: apply a preset globally, or only for the open project — with the file that will be written shown before you confirm.
- Dropdown of every preset, with the orchestrator model as a decision hint.
- Confirmation dialog before every switch; cancelling writes nothing.
- Writes **only** the `preset` key. Comments, ordering and formatting of the JSONC file stay intact.
- Per-agent editor behind the preset-editing setting: ordered fallback chain with a variant per entry, `inheritModelFrom`, temperature, skills/skills_add/skills_remove, MCPs, permission, display name and color — written to the preset or to the root `agents` map, in either layer.
- Checks configured models against the effective model catalog and marks missing ones in red.
- Tracks active and recently finished sessions per agent, with live runtime display.
- Effective after a Managed Service restart (Settings → Apply & Restart).

## Install

1. OpenChamber → Settings → Extensions → Add extension.
2. Enter this repository's URL: `https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector.git`
3. Confirm the requested permissions:
   - `filesystem` for the global config
   - `files` for the project override
   - `sessions` for the per-agent session tracking
   - `service` (`exec: opencode`) for the model catalog check
4. Open the **oMo Slim Preset Selector** panel on the right rail.

Web and desktop clients are supported. The phone app and VS Code do not load extensions.

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

```bash
npm install
npm run build   # writes panel/main.js and service/main.js
npm run check   # build + iife + manifest + tests
npm test
npm run type-check
```

The built files are committed: OpenChamber installs extensions without building them. Bump `version` in `package.json` to ship an update through Git.

## Deploy

1. Bump `version` in `package.json`.
2. Run `npm run check` (build + IIFE check + manifest check + tests).
3. Commit everything, including the regenerated `panel/main.js`, `panel/index.html` and `service/main.js`.
4. Push to `origin/main`.
5. On the target machine, update the installed copy and rebuild if needed:
   ```bash
   cd ~/.config/openchamber/extensions/omo-preset
   git pull
   npm run build   # only if node_modules are present; otherwise the committed bundle is used
   ```
6. Reload OpenChamber (or the panel) so the new bundle is served.

The installed extension is a plain Git clone of this repository, so `git pull` is enough to bring in a released update.
## Permissions

| Permission | Why |
| --- | --- |
| `files` | Read/write the project override |
| `filesystem` | Read/write the global config |
| `sessions` | Track sub-sessions per agent |
| `service` (`exec: opencode`) | Run `opencode models` for the catalog check |

The extension only ever writes the `preset` key. The presets map, comments, ordering and formatting of the JSONC file are preserved.

## License

MIT

## Support

If you find this extension useful, you can support the development:

[![Donate with PayPal](https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif)](https://www.paypal.com/donate/?hosted_button_id=R5G9H9TFGQNUY)

[![ko-fi](https://storage.ko-fi.com/cdn/kofi5.png?v=6)](https://ko-fi.com/O4O01ZCNJE)
EOF
echo written