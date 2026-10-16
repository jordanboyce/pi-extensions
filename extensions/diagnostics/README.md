# pi-diagnostics

Runs a type checker or linter after every successful `edit` or `write` in [pi](https://pi.dev)
and appends what it found to the tool result, so the model sees the breakage it just introduced
instead of discovering it at the next test run. It is the closest pi gets to the LSP diagnostics
other agents surface after edits.

The model sees the normal edit result followed by a block like:

```
Diagnostics (tsc): 2 errors
  extensions/git-context/snapshot.ts:12:5 TS2322 Type 'number' is not assignable to type 'string'.
  extensions/git-context/snapshot.ts:40:3 TS2304 Cannot find name 'foo'.
```

Nothing is appended when the checker is happy. The result is never marked as an error (the edit
did succeed), `structuredContent` is preserved, and output is capped (`maxLines`, default 20).
The footer shows the last run as `diag: tsc ok` or `diag: tsc 2 errors`.

## Default checkers

| Files | Checker | How |
|---|---|---|
| `.ts` `.tsx` `.mts` `.cts` | `tsc` | `tsc -p <nearest tsconfig.json> --noEmit`, output filtered to the edited file. Without a tsconfig: `tsc --noEmit <file>`. |
| `.py` | `pyright`, else `pyflakes` | `pyright <file>` run from the nearest `pyproject.toml` directory; falls back to `python -m pyflakes <file>`. |
| `.go` | `go vet` | `go vet ./...` from the nearest `go.mod` directory, filtered to the edited file. |

The first candidate whose binary exists runs. Binaries are looked up without a shell: the
project's `node_modules/.bin` first (so the repo's own `tsc` version is used), then `PATH`
(honouring `PATHEXT` on Windows). npm's `.cmd` shims are unwrapped and run through pi's own
Node, so paths with spaces need no quoting anywhere. A binary that isn't installed is reported
once per session and then skipped silently.

A burst of edits to one project runs one check: calls within `debounceMs` (default 300) share a
run, and edits that land while a check is running wait for the next one instead of getting a
stale answer. Each run has a timeout (`timeoutMs`, default 20 s); a timed-out run is reported
once and appends nothing.

## Commands

`/diagnostics [status|on|off|run <file>]`: show config and the last result, toggle for this
session, or run the checker for a file by hand. `PI_DIAGNOSTICS=off` disables it for a run.

## Config (optional)

`~/.pi/agent/diagnostics.json` (`%USERPROFILE%\.pi\agent\` on Windows). A starter is in
[`diagnostics.example.json`](diagnostics.example.json). All keys are optional; `checkers` entries
are merged over the defaults by extension, and `false` removes a default:

```json
{
  "timeoutMs": 20000,
  "debounceMs": 300,
  "maxLines": 20,
  "checkers": {
    ".rs": { "name": "cargo check", "command": "cargo check --message-format short", "marker": "Cargo.toml", "timeoutMs": 60000 },
    ".py": [
      { "name": "pyright", "command": "pyright {file}", "marker": "pyproject.toml", "format": "pyright" },
      { "name": "pyflakes", "command": "python -m pyflakes {file}" }
    ],
    ".tsx": false
  }
}
```

A checker has:

- `command`: split like a shell line (quotes group words, there are no escapes); the first word is
  the binary. Placeholders: `{file}` (absolute path of the edited file), `{dir}` (its directory),
  `{root}` (see `marker`), `{marker}` (the marker file found), `{relfile}` (file relative to root),
  `{cwd}` (the session's cwd). A placeholder inside a word stays one argument, whatever it contains.
- `marker`: a file name such as `tsconfig.json`; the nearest ancestor directory holding one becomes
  `{root}` and the command's working directory. Without a marker, `{root}` is the session cwd.
- `fallback`: template used when the marker is not found. Without one, a command that needs
  `{marker}` is skipped; one that doesn't runs from the cwd.
- `format`: `tsc` (`file(line,col): error TSxxxx: msg`), `pyright` (`file:line:col - error: msg`),
  or `generic` (default; `file:line:col: msg`, which pyflakes, go vet, cargo's short format, gcc
  and most linters print). Relative paths in the output are resolved against `{root}`.
- `filter`: keep only lines about the edited file (default true). Diagnostics without a file, such
  as a broken tsconfig, are always kept.
- `timeoutMs`: per-checker override.

A malformed file (bad JSON, unknown key, unknown placeholder, a `format` that isn't one of the
three) is reported as a warning at session start and the defaults are used, so a typo never
silently turns the extension off.

## Notes

- Running `tsc -p` on every edit costs a full project type check, typically a few seconds. For a
  very large project, point `.ts` at a smaller tsconfig or raise `timeoutMs`.
- Checkers run with your user permissions on the files the model just wrote. The default commands
  only read; a custom `command` is yours to vet.
