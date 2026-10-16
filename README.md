# pi-extensions

Work extensions for the [pi](https://pi.dev) coding agent (`@earendil-works/pi-coding-agent`),
written against the Pi 1.x extension API and tested on Windows 11.

| Extension | What it does |
|---|---|
| [`env-switch`](extensions/env-switch/README.md) | Picks an env profile per repo (git remote, remote name, path) and swaps API keys/tokens in, so production keys and billing tiers never cross projects. Redacts secrets from tool output. |
| [`notes-sync`](extensions/notes-sync/README.md) | `/note`, `/decision`, `/arch`, `/todo` append to a folder Obsidian watches (optionally Joplin), tagged with project and branch. |
| [`git-context`](extensions/git-context/README.md) | Injects branch, recent commits, branch-only commits and uncommitted changes into the system prompt at startup. |

## Install

Pi keeps user extensions under `%USERPROFILE%\.pi\agent\` (not directly under `.pi\`).
Installing this repo as a **local package** loads it in place, with no copying, so
`git pull` here updates pi:

```powershell
pi install D:\vibe-repos\pi-extensions
pi list
```

Then `/reload` in a running session. To load only some of them, or to try one without installing:

```powershell
pi -e D:\vibe-repos\pi-extensions\extensions\git-context
```

Each extension folder is self-contained (no cross-imports), so you can also copy one folder to
`%USERPROFILE%\.pi\agent\extensions\<name>\` and pi will discover its `index.ts`.

Config files (all optional except `env-switch`'s profiles) live next to pi's own settings:

```
%USERPROFILE%\.pi\agent\
├── env-profiles.json     # env-switch: profiles + rules  (holds secrets/commands; keep private)
├── notes-sync.json       # notes-sync: vault path, layout, Joplin
├── git-context.json      # git-context: tuning
└── extensions\           # drop-in single-folder installs
```

Starter files are in each extension folder as `*.example.json`. The real names are in
`.gitignore` so they can't be committed by accident.

## Develop

```powershell
npm install
npm run check      # tsc --noEmit + node --test
pi -e .\extensions\env-switch    # run one extension from source; /reload after edits
```

Pi loads TypeScript directly (via `jiti`), so there is no build step. Tests cover the pure logic
of each extension (matching, redaction, formatting, snapshot parsing against a real temp git
repo, a mock Joplin server). Keep `profiles.ts`/`format.ts`/`snapshot.ts` free of pi imports so
they stay testable under plain `node --test`.

Pi extensions run with your full user permissions. Read anything you add here before loading it.

## Adding another extension

1. `extensions/<name>/index.ts` with `export default function (pi: ExtensionAPI) { … }`
   (the factory may be `async`).
2. Add `"./extensions/<name>/index.ts"` to `pi.extensions` in `package.json`.
3. Don't start timers/watchers in the factory; use `session_start` and clean up in `session_shutdown`.
4. Types and examples ship with pi: `docs/extensions.md` and `examples/extensions/` inside
   `@earendil-works/pi-coding-agent`.
