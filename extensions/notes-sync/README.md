# pi-notes-sync

Log decisions, architecture notes and todos from a [pi](https://pi.dev) session straight into a
folder your Obsidian vault watches (and optionally Joplin), tagged with the current **project**
and **git branch**. Nothing to switch windows for: type `/decision …` and keep working.

## Commands

| Command | Writes |
|---|---|
| `/note <text>` | a timestamped note |
| `/decision <text>` | a decision (and its why) |
| `/arch <text>` | an architecture note |
| `/todo <text>` | an Obsidian-Tasks checkbox: `- [ ] text #pi #todo #project/x #branch/y — 2026-10-16 14:03` |
| `/notes` (`path`) | the file this repo's notes go to |
| `/notes recent` | headings of the last few entries |
| `/notes open` | open that file in your default app |

With no text in the TUI, the command prompts for it. The model also gets a `save_note` tool
(disable with `"modelTool": false`) so you can say "log that decision"; its prompt guidance tells
it to call the tool only when you explicitly ask.

## Setup

Copy `notes-sync.example.json` to `%USERPROFILE%\.pi\agent\notes-sync.json`:

```json
{
  "vault": "C:\\Users\\me\\Documents\\Obsidian\\Work",
  "folder": "Pi Notes",
  "layout": "project",
  "tags": ["pi"],
  "modelTool": true
}
```

| Key | Meaning |
|---|---|
| `vault` / `folder` | Notes land in `<vault>\<folder>`. Without `vault`, they go to `~/.pi/agent/notes` and pi tells you once. |
| `layout` | `project` (default): `<folder>\<project>.md`. `daily`: `<folder>\<project>\YYYY-MM-DD.md`. |
| `tags` | Added to every entry (default `["pi"]`). |
| `joplin` | See below. |

`PI_NOTES_DIR` overrides the destination folder entirely; `PI_NOTES_CONFIG` overrides the config path.

## What lands in the vault

```markdown
---
project: "billing-api"
tags: [pi, project/billing-api]
---

# billing-api — pi notes

## 2026-10-16 14:03 · decision

**Project:** billing-api · **Branch:** `feature/new-ledger`

Use SQLite for local dev; Postgres is overkill here.

#pi #decision #project/billing-api #branch/feature/new-ledger
```

- **Project** = the `origin` remote's repo name (so worktrees and renamed folders still agree),
  else the folder name. **Branch** = current branch, or `detached-<sha>`.
- Tags are Obsidian-valid (`/` nests: `#branch/feature/new-ledger`). File names are sanitized for
  Windows (reserved names, `<>:"|?*`, trailing dots).
- Append-only: a first write creates the file with frontmatter; later writes only append.
  Concurrent sessions are safe.

## Joplin (optional)

Joplin has no watched-folder import, so this uses its local Data API. Enable it in Joplin under
*Options → Web Clipper*, copy the token into an environment variable, and add:

```json
"joplin": { "port": 41184, "notebook": "Pi Notes", "tokenEnv": "JOPLIN_TOKEN" }
```

Each entry also becomes a Joplin note (title `[decision] …`) in that notebook, with the same tags.
The host must be loopback and the token is read from the environment, never from the config file.
If Joplin is closed or rejects the call, the Markdown file is still written and you get a warning.
This path is covered by tests against a mock server, not against a live Joplin.
