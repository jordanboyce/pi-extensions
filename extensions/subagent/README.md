# pi-subagent

Gives the model a `subagent` tool: delegate one independent task to a child [pi](https://pi.dev)
session that runs in its own process with its own context window, and get back its final report.
It is pi's counterpart to Claude Code's `Agent` tool.

```
subagent({ task: "Add a --json flag to src/cli.ts that prints the report as JSON. Keep the text output the default. Add a test in test/cli.test.ts and run npm test." })
```

By default the child works in a **fresh git worktree on a new branch** (`subagent/<slug>-<id>`
under `.pi/worktrees/`), so several children can run at once without touching the caller's files
or each other's. The tool returns:

```
<the child's final message>

---
Status: completed
Branch: subagent/add-a-json-flag-to-src-cli-ts-3f9a1c (from 4480a88f2c)
Worktree: D:\work\repo\.pi\worktrees\add-a-json-flag-to-src-cli-ts-3f9a1c
Commits (1):
  9c2d1e0 cli: add --json flag
Files changed (2):
  src/cli.ts
  test/cli.test.ts
Diff stat:
   src/cli.ts       | 14 ++++++++--
   test/cli.test.ts | 22 ++++++++++++++
Session: C:\Users\me\.pi\agent\sessions\...\subagent-20261016-123456-add-a-json-flag....jsonl
  resume: pi --session "C:\Users\me\.pi\agent\sessions\...jsonl"
Usage: 6 turns, in 48k, out 3.1k, $0.0712, ctx 21k, claude-sonnet-4-5
```

The caller then merges or cherry-picks the branch. `isolation: "shared"` runs the child in place
instead (for read-only research, or directories that are not git repositories); the result then
lists only the files whose status changed during the run.

While the child runs, the tool call streams its progress (tool-call count, the last tool call and
the text it is writing), and the footer shows how many children are active. Ctrl+C in the parent
kills the child (and its process tree on Windows), keeps a worktree that has changes, and removes
one that is still clean.

## Parameters

| Parameter | Meaning |
|---|---|
| `task` | The complete brief. The child sees nothing of the parent conversation, so include the goal, relevant files, constraints and what done looks like. |
| `isolation` | `worktree` (default) or `shared`. |
| `model` | Model pattern for the child, as for `pi --model`. Default: the caller's model (and thinking level). |
| `cwd` | Directory to run in or to create the worktree from. Default: the caller's working directory. |

The child is told it is a subagent, that no one can answer questions, to work only in its
directory, to commit on its branch in worktree mode, and to end with a report for the caller.
The system prompt also carries guidelines: delegate only independent, well-specified pieces, never
work that needs the user's answers.

## How the child runs

The child is the same pi that is running the parent, started as `pi --mode json` with a
persistent session (this is the approach of the `subagent` example that ships with pi). It loads
the extensions pi normally discovers (installed packages, `~/.pi/agent/extensions`), plus whatever
the parent was started with via `-e`/`--extension`, so a parent started with
`pi -e ./pi-extensions/extensions/subagent` passes that on. The child inherits the environment with
`PI_SUBAGENT_DEPTH` incremented; at `maxDepth` (default 1) the extension does not register the tool
in the child, so children cannot fan out further.

Each child's session is persisted under the worktree's (or shared directory's) normal session
location, so `pi --session <path>` or `pi -r` inside that directory reopens it. Parents and children
share nothing else: no messages, no tool results.

## Config (optional)

`~/.pi/agent/subagent.json` (`%USERPROFILE%\.pi\agent\` on Windows), all keys optional:

```json
{
  "maxConcurrent": 3,
  "maxDepth": 1,
  "maxOutputChars": 16000,
  "worktreeDir": ".pi/worktrees",
  "branchPrefix": "subagent/",
  "inheritExtensions": true,
  "removeCleanWorktree": true,
  "timeoutMinutes": 0,
  "model": "claude-sonnet-4-5",
  "tools": ["read", "bash", "edit", "write"],
  "extraArgs": ["--no-mcp"],
  "piPath": "C:\\nvm4w\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js"
}
```

| Key | Default | Meaning |
|---|---|---|
| `maxConcurrent` | 3 | Children running at once; further calls wait for a slot (abort cancels the wait). |
| `maxDepth` | 1 | Nesting depth at which children stop getting the tool. |
| `maxOutputChars` | 16000 | Cap on the text returned to the caller. The summary is trimmed first; branch, files and session path always fit. |
| `worktreeDir` | `.pi/worktrees` | Relative to the repository root, or absolute. A relative dir is added to `.git/info/exclude` so worktrees never show as untracked files. |
| `branchPrefix` | `subagent/` | Branch name prefix for worktree runs. |
| `inheritExtensions` | true | Forward the parent's `-e`/`--extension` and `--no-extensions` flags. |
| `removeCleanWorktree` | true | Remove the worktree and branch when the child changed nothing. |
| `timeoutMinutes` | 0 | Kill children that run longer than this (0 = no limit). |
| `model` | parent's | Default model for children. The `model` parameter overrides it. |
| `tools` | pi's default | The child's `--tools` list, e.g. `["read", "grep", "find", "ls"]` for read-only children. |
| `extraArgs` | `[]` | Extra CLI arguments for every child. |
| `piPath` | auto | Path to pi's `cli.js` (run with the current Node) or to a pi executable, when auto-detection fails. |

A malformed file is reported as a warning at session start and the defaults are used.

## Notes

- Worktree mode needs a git repository with at least one commit; otherwise the tool says so and
  suggests `isolation: "shared"`.
- A worktree that the child left clean is removed; one with changes stays, and the result says
  whether changes are committed. Clean up kept worktrees with `git worktree remove <path>` and
  `git branch -D <branch>`, or `git worktree prune` after deleting the directory.
- The child runs with your full user permissions, like pi itself. The brief comes from the model,
  so treat it as you would any other tool call pi makes.
- Windows: worktree paths use backslashes, git is invoked through pi's `exec`, and an aborted child
  is killed with `taskkill /T` so its shells die with it. Git for Windows refuses worktrees whose
  internal path (`<repo>/.git/worktrees/<name>`) nears 260 characters (`'$GIT_DIR' too big`); for a
  repository that deep, point `worktreeDir` at a short absolute path or clone it somewhere shorter.
  A creation that fails this way is cleaned up (no stray branch).
