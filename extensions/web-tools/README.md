# pi-web-tools

[pi](https://pi.dev) ships no web tools. This extension gives the model the two that are missed
most often: **`web_fetch`** (read a page) and **`web_search`** (find pages). Both are
model-callable tools; there are no slash commands.

## Tools

### `web_fetch(url, maxChars?)`

GETs the URL and returns its readable text, the final URL after redirects and the content type.

| Served as | Returned as |
|---|---|
| HTML | Markdown. Scripts, styles, `<nav>`, `<footer>`, `<aside>`, forms controls and hidden elements are dropped; `<main>` (or a lone `<article>`) is preferred over the whole body. Headings, paragraphs, lists, links (made absolute), inline and fenced code, blockquotes, tables and definition lists are rendered. |
| Markdown, plain text, other `text/*` | As served |
| JSON | Pretty-printed |
| Anything else (images, PDF, binaries) | Refused with a clear error |

The converter is a small hand-written tokenizer, not a browser: JavaScript-rendered pages return
whatever the server sent. Mislabelled `text/plain` that is really HTML is sniffed and converted.
Charsets come from the `Content-Type` header or a `<meta charset>`.

Limits:

- Only `http:` and `https:`. URLs with embedded credentials are refused.
- Loopback, private-network (RFC 1918, CGNAT), link-local (including cloud metadata
  `169.254.169.254`), `localhost`/`*.localhost`/`*.local`/`*.internal` names, and host names that
  **resolve** to any of those are refused unless `fetch.allowPrivate` is `true`. Every redirect hop
  is checked again, so a public page cannot bounce the agent into your LAN.
- At most 5 redirects; the response body stops downloading at `fetch.maxBytes` (2 MiB default);
  the request is aborted after `fetch.timeoutMs` (20 s default).
- Output is cut at `maxChars` (the parameter, capped by `fetch.maxChars`, 40 000 default). When
  cut, the result ends with a note saying how much was shown and the path of a temp file holding
  the full text, which the model can open with its `read` tool.

### `web_search(query, count?)`

Calls one provider's HTTP API and returns a numbered list of `title / URL / snippet` rows, ending
with a reminder that snippets are excerpts. Supported providers:

| Provider | Default key variable | Endpoint |
|---|---|---|
| [Brave Search API](https://brave.com/search/api/) | `BRAVE_SEARCH_API_KEY` | `https://api.search.brave.com/res/v1/web/search` (GET, `X-Subscription-Token`) |
| [Tavily](https://tavily.com/) | `TAVILY_API_KEY` | `https://api.tavily.com/search` (POST, `Authorization: Bearer`) |

The key is read from the environment at call time, never from the config file, and is sent only in
a header or JSON body (never in the URL, so it does not end up in logs). With the variable unset
the tool fails with a message naming the variable and provider. HTTP 401/403 and 429 responses get
hints as well. `count` is clamped to 1–20.

### Prompt guidance

Each tool adds guidelines to pi's system prompt: fetch a page before quoting or summarising it,
cite the URLs you rely on, and read the saved full text rather than guessing when a result was
truncated.

## Setup

Nothing is required for `web_fetch`. For `web_search`, export an API key:

```sh
export BRAVE_SEARCH_API_KEY=...     # or TAVILY_API_KEY with "provider": "tavily"
```

Optionally copy `web-tools.example.json` to `~/.pi/agent/web-tools.json`
(`%USERPROFILE%\.pi\agent\` on Windows):

```json
{
  "fetch": {
    "timeoutMs": 20000,
    "maxBytes": 2097152,
    "maxChars": 40000,
    "allowPrivate": false,
    "allow": [],
    "deny": ["*.internal.example.com"]
  },
  "search": { "provider": "brave", "apiKeyEnv": "BRAVE_SEARCH_API_KEY", "count": 5 }
}
```

| Key | Meaning |
|---|---|
| `fetch.timeoutMs` | Abort a request after this long. Default 20000 (minimum 1000). |
| `fetch.maxBytes` | Stop downloading a body after this many bytes. Default 2 MiB. |
| `fetch.maxChars` | Default and ceiling for the `maxChars` parameter. Default 40000. |
| `fetch.allowPrivate` | Allow loopback/private/link-local targets (local dev servers). Default `false`. |
| `fetch.allow` | Host globs. When non-empty, only matching hosts may be fetched. |
| `fetch.deny` | Host globs that may never be fetched. Checked before `allow`. |
| `fetch.userAgent` | `User-Agent` header. |
| `search.provider` | `"brave"` (default) or `"tavily"`. |
| `search.apiKeyEnv` | Environment variable holding the key. Defaults per provider, see above. |
| `search.count` | Default number of results. Default 5, at most 20. |
| `search.endpoint` | Override the provider URL (proxy, tests). |

Host globs: `*` matches any run of characters and matching is case-insensitive on the host name
without port. `*.example.com` does **not** match `example.com` itself; list both if you want both.

`PI_WEB_TOOLS_CONFIG` overrides the config path. A config that fails validation makes both tools
fail with the file name and the offending key until it is fixed.

## Notes

- Private-address checks resolve the host once before connecting; a DNS record that changes
  between the check and the connection (DNS rebinding) is not caught. Keep `allowPrivate` off on
  machines that can reach things you would not want the model to read.
- Fetched content is untrusted. The tool returns it verbatim as text; it is up to the model (and
  pi's prompt) to treat instructions found in pages as data.
- Everything except the actual `fetch` and DNS calls lives in `web.ts`, which has no pi imports;
  `test/web-tools.test.ts` runs it against a local `node:http` server (redirect chains, caps,
  charsets, both search providers) and never touches the network.
