/**
 * pi-web-tools
 *
 * Gives the model two web tools pi lacks out of the box:
 *
 *   web_fetch(url, maxChars?)   GET a page and return its readable text as Markdown
 *   web_search(query, count?)   query Brave Search or Tavily and return title/URL/snippet rows
 *
 * Fetches refuse non-http(s) schemes and, by default, loopback/private/link-local
 * targets (also on every redirect hop). Config in ~/.pi/agent/web-tools.json.
 */

import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	FETCH_DEFAULTS,
	MAX_SEARCH_COUNT,
	fetchPage,
	formatFetchResult,
	formatSearchResults,
	resolveSearchConfig,
	searchWeb,
	truncateText,
	validateConfig,
	type FetchLike,
	type LookupLike,
	type WebToolsConfig,
} from "./web.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function configPath(): string {
	return process.env.PI_WEB_TOOLS_CONFIG || join(agentDir(), "web-tools.json");
}

async function loadConfig(): Promise<WebToolsConfig> {
	const file = configPath();
	try {
		const parsed = validateConfig(JSON.parse(await readFile(file, "utf8")));
		if (parsed.error) throw new Error(`${file}: ${parsed.error}`);
		return parsed.config ?? {};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
		if (e instanceof SyntaxError) throw new Error(`${file}: not valid JSON (${e.message})`);
		throw e;
	}
}

const dnsLookup: LookupLike = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
const realFetch = fetch as unknown as FetchLike;

export default function webTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_fetch",
		label: "Web fetch",
		description:
			"Fetch a web page by URL and return its readable text (HTML is converted to Markdown; plain text, Markdown and JSON are returned as-is) " +
			"together with the final URL after redirects and the content type. Only http(s) URLs; private and loopback addresses are refused unless configured. " +
			`Output is capped at maxChars (default ${FETCH_DEFAULTS.maxChars}); when truncated, the full text is saved to a file whose path is given in the result.`,
		promptSnippet: "web_fetch: fetch a URL and read its content as Markdown (HTML, text, Markdown, JSON)",
		promptGuidelines: [
			"Fetch a page with web_fetch before quoting or summarising it; search snippets are not a source.",
			"When you use information from a fetched page, cite its URL in your answer.",
			"If a web_fetch result says it was truncated, read the saved full-text file or re-fetch with a smaller scope rather than guessing at the rest.",
		],
		parameters: Type.Object({
			url: Type.String({ description: "Absolute http(s) URL to fetch" }),
			maxChars: Type.Optional(
				Type.Integer({
					minimum: 500,
					description: `Maximum characters of text to return (default and ceiling come from config, default ${FETCH_DEFAULTS.maxChars})`,
				}),
			),
		}),
		async execute(_id, params, signal) {
			const config = await loadConfig();
			const fetchCfg = config.fetch ?? {};
			const ceiling = fetchCfg.maxChars ?? FETCH_DEFAULTS.maxChars;
			const maxChars = Math.min(params.maxChars ?? ceiling, ceiling);
			const page = await fetchPage(params.url, fetchCfg, { fetch: realFetch, lookup: dnsLookup, signal });
			const body = truncateText(page.text, maxChars);
			let fullTextPath: string | undefined;
			if (body.truncated) {
				const dir = await mkdtemp(join(tmpdir(), "pi-web-fetch-"));
				fullTextPath = join(dir, page.kind === "html" || page.kind === "markdown" ? "page.md" : page.kind === "json" ? "page.json" : "page.txt");
				await writeFile(fullTextPath, page.text, "utf8");
			}
			return {
				content: [{ type: "text", text: formatFetchResult({ page, body, fullTextPath, maxChars }) }],
				details: {
					url: params.url,
					finalUrl: page.url,
					status: page.status,
					contentType: page.contentType,
					kind: page.kind,
					title: page.title,
					redirects: page.redirects,
					chars: body.total,
					shown: body.shown,
					truncated: body.truncated || page.bodyTruncated,
					fullTextPath,
				},
			};
		},
	});

	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web and return a numbered list of results with title, URL and snippet. " +
			"Uses the search provider configured in ~/.pi/agent/web-tools.json (Brave Search or Tavily) with an API key from the environment. " +
			"Snippets are excerpts: fetch a result with web_fetch before relying on its content.",
		promptSnippet: "web_search: search the web (Brave or Tavily) for titles, URLs and snippets",
		promptGuidelines: [
			"Use web_search for current events, library versions, documentation and anything you are unsure about; then web_fetch the promising results instead of answering from snippets.",
			"Cite the URLs of search results you rely on.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_COUNT, description: `Number of results (default from config, usually 5; at most ${MAX_SEARCH_COUNT})` })),
		}),
		async execute(_id, params, signal) {
			const config = await loadConfig();
			const resolved = resolveSearchConfig(config.search);
			const results = await searchWeb(params.query, params.count, config.search, {
				fetch: realFetch,
				env: process.env,
				signal,
				timeoutMs: config.fetch?.timeoutMs,
			});
			return {
				content: [{ type: "text", text: formatSearchResults(params.query, results, resolved.provider) }],
				details: { provider: resolved.provider, query: params.query, count: results.length, results },
			};
		},
	});
}
