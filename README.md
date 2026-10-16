# pi-extensions

Extensions for the [pi](https://pi.dev) coding agent (`@earendil-works/pi-coding-agent`),
written against the Pi 1.x extension API. They run on Windows, macOS and Linux.

| Extension | What it does |
|---|---|
| [`env-switch`](extensions/env-switch/README.md) | Picks an env profile per repo (git remote, remote name, path) and swaps API keys/tokens in, so production keys and billing tiers never cross projects. Redacts secrets from tool output. |
| [`notes-sync`](extensions/notes-sync/README.md) | `/note`, `/decision`, `/arch`, `/todo` append to a folder Obsidian watches (optionally Joplin), tagged with project and branch. |
| [`git-context`](extensions/git-context/README.md) | Injects branch, recent commits, branch-only commits and uncommitted changes into the system prompt at startup. |

## Install

Straight from GitHub (pi clones it into its package store and keeps it updated with `pi update`):

```sh
pi install https://github.com/jordanboyce/pi-extensions
pi list
```

Or clone it yourself and install the checkout as a **local package**. Pi loads it in place, so a
`git pull` in the clone updates pi:

```sh
git clone https://github.com/jordanboyce/pi-extensions.git
pi install ./pi-extensions
```

Then `/reload` in a running session. To load only one extension, or to try one without installing:

```sh
pi -e ./pi-extensions/extensions/git-context
```

Each extension folder is self-contained (no cross-imports), so you can also copy one folder into
pi's user extension directory, `~/.pi/agent/extensions/<name>/`, and pi will discover its `index.ts`.

## Configure

Pi keeps user-level files under `~/.pi/agent/` (`%USERPROFILE%\.pi\agent\` on Windows; not
directly under `.pi\`). Config files, all optional except `env-switch`'s profiles, live there next
to pi's own settings:

```
~/.pi/agent/
├── env-profiles.json     # env-switch: profiles + rules  (holds secrets/commands; keep private)
├── notes-sync.json       # notes-sync: vault path, layout, Joplin
├── git-context.json      # git-context: tuning
└── extensions/           # drop-in single-folder installs
```

Starter files are in each extension folder as `*.example.json`. The real names are in
`.gitignore` so they can't be committed by accident.

## Develop

Requires Node 22.18 or newer (the tests run TypeScript directly through Node's type stripping).

```sh
npm install
npm run check                     # tsc --noEmit + node --test
pi -e ./extensions/env-switch     # run one extension from source; /reload after edits
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
