# Security Policy

## Supported versions

Security fixes land in the latest published release only. Update through **Settings → Extensions** in OpenChamber, or reinstall from the latest tag for a pinned setup.

| Version | Supported |
| --- | --- |
| Latest GitHub Release | ✅ |
| Older releases | ❌ |

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting:

https://github.com/TauNeutrino/openchamber-omo-slim-preset-selector/security/advisories/new

Please do not open a public issue containing reproduction steps, exploit details, file paths or any other information that could be used against other users before a fix is available.

A useful report includes the extension version, your OpenChamber version and platform, and a minimal reproduction.

## Trust surface

The extension runs inside OpenChamber with these declared permissions:

- `filesystem` — reads and writes the global config at `~/.config/opencode/oh-my-opencode-slim.json` or `.jsonc`.
- `files` — a broad project-file permission; this extension reads and writes only the project override at `.opencode/oh-my-opencode-slim.json` or `.jsonc` in the open project.
- `sessions` — reads session metadata to track active and recently finished sessions per agent.
- `service` (`exec: opencode`) — the host runs the local service with your user privileges; it invokes `opencode models` for the catalog check, but the declared `exec` command is not a sandbox.

## In scope

- Escalating beyond the declared permissions, or reading or writing outside the declared config paths.
- Command execution beyond the declared `opencode models` service call.
- Leaking session metadata, project file contents or other host data.
- Dependency or supply-chain issues, and tampered, unexpected or non-reproducible committed bundles (`panel/main.js`, `service/main.js`).

## Out of scope

- Vulnerabilities in OpenChamber itself, `opencode`, or `oh-my-opencode-slim`; report those to their own projects.
- Problems caused by a deliberately modified local checkout, configuration or extension host.
- Social engineering and physically local attacks.
