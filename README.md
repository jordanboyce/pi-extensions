# pi-extensions

Extensions for the [pi](https://pi.dev) coding agent (`@earendil-works/pi-coding-agent`),
written against the Pi 1.x extension API. They run on Windows, macOS and Linux.

| Extension | What it does |
|---|---|
| [`env-switch`](extensions/env-switch/README.md) | Picks an env profile per repo (git remote, remote name, path) and swaps API keys/tokens in, so production keys and billing tiers never cross projects. Redacts secrets from tool output. |
| [`notes-sync`](extensions/notes-sync/README.md) | `/note`, `/decision`, `/arch`, `/todo` append to a folder Obsidian watches (optionally Joplin), tagged with project and branch. |
| [`git-context`](extensions/git-context/README.md) | Injects branch, recent commits, branch-only commits and uncommitted changes into the system prompt at startup. |
| [`subagent`](extensions/subagent/README.md) | A `subagent` tool: delegates an independent task to a child pi session, by default in a fresh git worktree on its own branch, and returns its report, files changed, branch and session file. |
| [`web-tools`](extensions/web-tools/README.md) | `web_fetch` (URL to readable Markdown, with redirect and private-address guards) and `web_search` (Brave Search or Tavily) tools for the model. |
| [`diagnostics`](extensions/diagnostics/README.md) | Runs `tsc`, `pyright`/`pyflakes` or `go vet` after every edit or write and appends the errors for the touched file to the tool result, so the model sees what it broke immediately. |
| [`screenshots`](extensions/screenshots/README.md) | Attaches image paths in a prompt (Alt+V pastes, drag-and-drop, typed paths) as real images when you send. `/screenshot` adds your newest Win+Shift+S / Cmd+Shift+4 capture, and `/paste-image` adds the clipboard image. |

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
├── subagent.json         # subagent: concurrency, worktree dir, child model/tools
├── web-tools.json        # web-tools: fetch limits, host lists, search provider
├── diagnostics.json      # diagnostics: checker commands per extension
├── screenshots.json      # screenshots: attach limits, screenshot folders
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
repo, a mock Joplin server, a local HTTP server for web fetch/search). Keep each extension's pure
module (`profiles.ts`, `format.ts`, `snapshot.ts`, `core.ts`, `web.ts`, `checkers.ts`, `attach.ts`) free of pi imports so
they stay testable under plain `node --test`.

Pi extensions run with your full user permissions. Read anything you add here before loading it.

## Adding another extension

1. `extensions/<name>/index.ts` with `export default function (pi: ExtensionAPI) { … }`
   (the factory may be `async`). Put the logic that doesn't need pi in a sibling module with no
   pi imports, and test it in `test/<name>.test.ts`.
2. If it reads a config file, name it `~/.pi/agent/<name>.json`, validate it in the pure module,
   ship `extensions/<name>/<name>.example.json`, and add the real name to `.gitignore`.
3. Add `"./extensions/<name>/index.ts"` to `pi.extensions` in `package.json`, a row to the table
   above, and a line to the config tree if it has a config file. Give it its own `README.md`.
4. Don't start timers/watchers in the factory; use `session_start` and clean up in `session_shutdown`.
   A `tool_result` handler that replaces `content` must also return `structuredContent`, or pi drops it.
5. Types and examples ship with pi: `docs/extensions.md` and `examples/extensions/` inside
   `@earendil-works/pi-coding-agent`.
