# pi-env-switch

Per-repository environment switching for [pi](https://pi.dev). On session start it works out
which repo you're in (git remote URL, remote names, path, repo name), picks a **profile**, and
injects that profile's variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, custom service tokens)
into the pi process. Switching repos can't leave the previous repo's billing tier active, and
variables are restored on exit/reload.

## Setup

1. Copy `env-profiles.example.json` to `~/.pi/agent/env-profiles.json` (`%USERPROFILE%\.pi\agent\`
   on Windows) and edit it. (Honors `PI_CODING_AGENT_DIR`; override the file with `PI_ENV_PROFILES_FILE`.)
2. Start pi inside a repo. The footer shows `env:<profile>`.

## Profiles

```jsonc
"acme-dev": {
  "description": "…",
  "warn": "shown as a warning on activation",
  "env":   { "NAME": "<value>" },
  "unset": ["OPENAI_API_KEY"],     // removed while this profile is active
  "redact": ["ACME_BASE_URL"]      // extra names to redact (KEY/TOKEN/SECRET/PASSWORD are automatic)
}
```

Value forms:

| Form | Meaning |
|---|---|
| `literal` | used as-is (avoid for real secrets) |
| `${OTHER_VAR}` | interpolated from your real environment (e.g. a user-level var per project) |
| `!command` | stdout of a command, e.g. `!op read op://Vault/item/field`, `!pass show acme/key` |
| `file:path` | contents of a file (trimmed); `${VAR}` works inside the path, e.g. `file:${HOME}/.secrets/token` (`${USERPROFILE}` on Windows) |

## Choosing the profile

Precedence, first hit wins:

1. `--env-profile <name>` CLI flag
2. `PI_ENV_PROFILE` environment variable
3. `.pi/env-profile` in the repo root: a single line holding a profile name (safe to commit)
4. First matching entry in `rules`
5. `default`

A rule can match on `remote` (URL glob, normalized to `host/owner/repo`, so `git@` and `https://`
forms are equivalent), `remoteName` (any git remote's name), `path` (absolute repo root, forward
slashes or backslashes; `~` is not expanded, so write `**/work/acme/**` or the full path), and
`repo`. Fields in one rule are ANDed; a list within a field is ORed. Globs are case-insensitive;
`*` stays within a path segment, `**` crosses them.

## Guarded commands

A profile can list regular expressions that the agent's shell commands must not match while it
is active:

```jsonc
"acme-prod": {
  "warn": "PRODUCTION keys are active.",
  "env": { … },
  "guard": ["\\bgit\\s+push\\b", "\\bterraform\\s+(apply|destroy)\\b", "\\bkubectl\\s+(apply|delete|rollout)\\b"]
}
```

Patterns are matched case-insensitively against the whole command line of every `bash` and
`powershell` tool call (so `cd api && git push --force` is caught). A match blocks the call before
it runs; the model is told which profile and pattern blocked it and to ask you instead, and you
get a warning in the UI. `/env` lists the active guards.

This is a tripwire against the agent running a destructive command with production credentials,
not a security boundary: it only inspects the command text, so an indirect route (a script that
pushes, an alias) gets through, and commands you type yourself with `!` are never blocked.
Patterns that don't compile are rejected when the config loads.

## Commands

| Command | Does |
|---|---|
| `/env` | Active profile, how it was chosen, and the variables set: secrets as a `…1234` fingerprint, plain settings (base URLs, regions) in full |
| `/env list` | All profiles (`*` marks the active one) |
| `/env use <name>` | Switch for the rest of this session |
| `/env off` | Restore the original environment |
| `/env reload` | Re-read the config and re-resolve (after editing it) |

## Safety properties

- **Repos can't define values.** Only your user-level file holds secrets and commands; a repo can
  only *name* a profile. A hostile clone can at worst pick one of your own profiles.
- **Redaction.** While a profile is active, values of variables named like `*KEY*`, `*TOKEN*`,
  `*SECRET*`, `*PASSWORD*` (≥ 8 chars) are replaced with `[redacted:NAME]` in tool output, so
  `env`/`printenv` or a leaked config dump doesn't put them in the model's context. Both the text
  content and a tool's `structuredContent` (JSON results) are redacted. Set `"redact": false` at
  the top level to disable.
- **Not hidden from commands the agent runs.** Variables live in the pi process, so child
  processes (bash tool, test runs) inherit them. That's intended, but it means the agent can use
  the keys; redaction only stops it *reading* them.
- `.gitignore` in this repo excludes `env-profiles.json`, so a real config can't be committed by accident.

## Caveats

- Provider keys are read from `process.env` at request time, so a switch takes effect on the
  next request. If `auth.json` holds a stored credential for the same provider, it may take
  priority over the environment; the extension warns once when it sees this. `/logout <provider>`
  removes the stored key.
- `!command` values run through `cmd.exe /c` on Windows (`sh -c` elsewhere) with a 15 s timeout.
  They're re-run on every activation (session start, `/env use`, `/env reload`).
