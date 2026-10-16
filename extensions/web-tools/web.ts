/**
 * Pure helpers for pi-web-tools: config shape, URL policy (schemes, private
 * addresses, host globs), page fetching with redirects and caps, HTML to
 * Markdown, search providers and result formatting. No pi imports, and both
 * `fetch` and DNS lookup are injected, so everything is unit-testable against a
 * local node:http server.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const PROVIDERS = ["brave", "tavily"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface FetchConfig {
	/** Abort a request after this many milliseconds. Default 20000. */
	timeoutMs?: number;
	/** Stop downloading a body after this many bytes. Default 2 MiB. */
	maxBytes?: number;
	/** Default and ceiling for the `maxChars` tool parameter. Default 40000. */
	maxChars?: number;
	/** Allow loopback, private-network and link-local targets. Default false. */
	allowPrivate?: boolean;
	/** Host globs; when non-empty only matching hosts may be fetched. */
	allow?: string[];
	/** Host globs that may never be fetched. Checked before `allow`. */
	deny?: string[];
	/** User-Agent header. */
	userAgent?: string;
}

export interface SearchConfig {
	/** Default "brave". */
	provider?: Provider;
	/** Env var holding the API key. Default BRAVE_SEARCH_API_KEY / TAVILY_API_KEY. */
	apiKeyEnv?: string;
	/** Default result count. Default 5, ceiling 20. */
	count?: number;
	/** Override the provider's endpoint (tests, proxies). */
	endpoint?: string;
}

export interface WebToolsConfig {
	fetch?: FetchConfig;
	search?: SearchConfig;
}

export const FETCH_DEFAULTS: Required<Omit<FetchConfig, "allow" | "deny">> & { allow: string[]; deny: string[] } = {
	timeoutMs: 20_000,
	maxBytes: 2 * 1024 * 1024,
	maxChars: 40_000,
	allowPrivate: false,
	allow: [],
	deny: [],
	userAgent: "pi-web-tools/0.1 (+https://pi.dev)",
};

export const MAX_REDIRECTS = 5;
export const MAX_SEARCH_COUNT = 20;
export const DEFAULT_SEARCH_COUNT = 5;

export const DEFAULT_KEY_ENV: Record<Provider, string> = {
	brave: "BRAVE_SEARCH_API_KEY",
	tavily: "TAVILY_API_KEY",
};

export const DEFAULT_ENDPOINT: Record<Provider, string> = {
	brave: "https://api.search.brave.com/res/v1/web/search",
	tavily: "https://api.tavily.com/search",
};

/** Undici wraps socket errors in a TypeError whose `cause` carries the useful text. */
function errorMessage(e: unknown): string {
	const cause = (e as { cause?: unknown }).cause;
	if (cause instanceof Error && cause.message) return cause.message;
	return e instanceof Error ? e.message : String(e);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
}

export function validateConfig(raw: unknown): { config?: WebToolsConfig; error?: string } {
	if (!isPlainObject(raw)) return { error: "config must be a JSON object" };
	for (const key of Object.keys(raw)) {
		if (key !== "fetch" && key !== "search") return { error: `unknown key "${key}" (expected "fetch" and/or "search")` };
	}
	if (raw.fetch !== undefined) {
		if (!isPlainObject(raw.fetch)) return { error: '"fetch" must be an object' };
		const f = raw.fetch;
		for (const [key, min] of [
			["timeoutMs", 1000],
			["maxBytes", 1024],
			["maxChars", 500],
		] as const) {
			const v = f[key];
			if (v !== undefined && (!Number.isInteger(v) || (v as number) < min)) return { error: `fetch.${key} must be an integer >= ${min}` };
		}
		if (f.allowPrivate !== undefined && typeof f.allowPrivate !== "boolean") return { error: "fetch.allowPrivate must be true or false" };
		for (const key of ["allow", "deny"] as const) {
			if (f[key] !== undefined && !isStringArray(f[key])) return { error: `fetch.${key} must be an array of host globs` };
		}
		if (f.userAgent !== undefined && (typeof f.userAgent !== "string" || !f.userAgent)) return { error: "fetch.userAgent must be a non-empty string" };
		for (const key of Object.keys(f)) {
			if (!(key in FETCH_DEFAULTS)) return { error: `unknown key fetch.${key}` };
		}
	}
	if (raw.search !== undefined) {
		if (!isPlainObject(raw.search)) return { error: '"search" must be an object' };
		const s = raw.search;
		if (s.provider !== undefined && !PROVIDERS.includes(s.provider as Provider)) {
			return { error: `search.provider must be one of ${PROVIDERS.map((p) => `"${p}"`).join(", ")}` };
		}
		if (s.apiKeyEnv !== undefined && (typeof s.apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.apiKeyEnv))) {
			return { error: "search.apiKeyEnv must be an environment variable name" };
		}
		if (s.count !== undefined && (!Number.isInteger(s.count) || (s.count as number) < 1 || (s.count as number) > MAX_SEARCH_COUNT)) {
			return { error: `search.count must be an integer between 1 and ${MAX_SEARCH_COUNT}` };
		}
		if (s.endpoint !== undefined) {
			if (typeof s.endpoint !== "string" || !/^https?:\/\//i.test(s.endpoint)) return { error: "search.endpoint must be an http(s) URL" };
		}
		for (const key of Object.keys(s)) {
			if (!["provider", "apiKeyEnv", "count", "endpoint"].includes(key)) return { error: `unknown key search.${key}` };
		}
	}
	return { config: raw as WebToolsConfig };
}

// ---------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------

/** `*` matches any run of characters; matching is case-insensitive on the host name (no port). */
export function hostGlobToRegExp(glob: string): RegExp {
	const escaped = glob
		.toLowerCase()
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`, "i");
}

export function hostMatches(host: string, globs: readonly string[]): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	return globs.some((g) => hostGlobToRegExp(g.replace(/\.$/, "")).test(h));
}

/** Why a host is refused by the allow/deny lists, or undefined when it passes. */
export function hostPolicyError(host: string, cfg: Pick<FetchConfig, "allow" | "deny">): string | undefined {
	if (cfg.deny?.length && hostMatches(host, cfg.deny)) return `host "${host}" is on the deny list`;
	if (cfg.allow?.length && !hostMatches(host, cfg.allow)) return `host "${host}" is not on the allow list`;
	return undefined;
}

function parseIpv4(s: string): number[] | undefined {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
	if (!m) return undefined;
	const parts = m.slice(1).map(Number);
	return parts.every((p) => p <= 255) ? parts : undefined;
}

/** Loopback, unspecified, RFC 1918, link-local (incl. cloud metadata 169.254/16), CGNAT, multicast/reserved. */
export function isPrivateIpv4(ip: string): boolean {
	const p = parseIpv4(ip);
	if (!p) return false;
	const [a, b] = p as [number, number, number, number];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

/** Expand an IPv6 textual address to 8 hextets; undefined when it is not valid IPv6. */
function parseIpv6(s: string): number[] | undefined {
	let addr = s.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
	// Embedded IPv4 tail (::ffff:1.2.3.4)
	const tail = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
	if (tail) {
		const v4 = parseIpv4(tail[1] as string);
		if (!v4) return undefined;
		const [a, b, c, d] = v4 as [number, number, number, number];
		addr = `${addr.slice(0, tail.index)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = addr.split("::");
	if (halves.length > 2) return undefined;
	const toHextets = (part: string): number[] | undefined => {
		if (part === "") return [];
		const out: number[] = [];
		for (const h of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/.test(h)) return undefined;
			out.push(parseInt(h, 16));
		}
		return out;
	};
	const head = toHextets(halves[0] as string);
	const rest = halves.length === 2 ? toHextets(halves[1] as string) : [];
	if (!head || !rest) return undefined;
	if (halves.length === 1) return head.length === 8 ? head : undefined;
	const fill = 8 - head.length - rest.length;
	if (fill < 1) return undefined;
	return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

export function isPrivateIpv6(ip: string): boolean {
	const h = parseIpv6(ip);
	if (!h) return false;
	const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
	const leadingZero = h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0;
	if (leadingZero && h5 === 0 && h6 === 0 && (h7 === 0 || h7 === 1)) return true; // :: and ::1
	if (leadingZero && h5 === 0xffff) return isPrivateIpv4(`${h6 >> 8}.${h6 & 0xff}.${h7 >> 8}.${h7 & 0xff}`); // ::ffff:a.b.c.d
	if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	if ((h0 & 0xff00) === 0xff00) return true; // multicast
	return false;
}

export function isIpLiteral(host: string): boolean {
	return parseIpv4(host) !== undefined || parseIpv6(host) !== undefined;
}

export function isPrivateAddress(ip: string): boolean {
	return isPrivateIpv4(ip) || isPrivateIpv6(ip);
}

/** Names that always mean "this machine" without a DNS round trip. */
export function isLocalHostname(host: string): boolean {
	const h = host.toLowerCase().replace(/\.$/, "");
	return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal");
}

export type LookupLike = (host: string) => Promise<string[]>;

export interface PolicyDeps {
	lookup: LookupLike;
}

/**
 * Validates a URL against scheme, allow/deny and private-address rules. Resolves the host (via the
 * injected lookup) when needed. Returns the parsed URL or throws with a model-readable message.
 */
export async function checkUrl(raw: string, cfg: FetchConfig, deps: PolicyDeps): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`invalid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`refusing ${url.protocol.replace(/:$/, "")} URL; only http and https are fetched`);
	}
	if (url.username || url.password) throw new Error("refusing URL with embedded credentials");
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!host) throw new Error(`invalid URL: ${raw}`);
	const policy = hostPolicyError(host, cfg);
	if (policy) throw new Error(policy);
	if (!(cfg.allowPrivate ?? FETCH_DEFAULTS.allowPrivate)) {
		const refuse = (what: string) => new Error(`refusing ${what}; set fetch.allowPrivate to true in web-tools.json to fetch private/loopback addresses`);
		if (isLocalHostname(host)) throw refuse(`local host name "${host}"`);
		if (isIpLiteral(host)) {
			if (isPrivateAddress(host)) throw refuse(`private address ${host}`);
		} else {
			let addrs: string[];
			try {
				addrs = await deps.lookup(host);
			} catch (e) {
				throw new Error(`could not resolve ${host}: ${(e as Error).message}`);
			}
			if (!addrs.length) throw new Error(`could not resolve ${host}`);
			const bad = addrs.find(isPrivateAddress);
			if (bad) throw refuse(`${host}, which resolves to private address ${bad}`);
		}
	}
	return url;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export interface FetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
	redirect?: "manual" | "follow" | "error";
}

export interface FetchResponseLike {
	status: number;
	ok: boolean;
	url: string;
	headers: { get(name: string): string | null };
	body: AsyncIterable<Uint8Array> | null;
	text(): Promise<string>;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<FetchResponseLike>;

export interface FetchDeps extends PolicyDeps {
	fetch: FetchLike;
	signal?: AbortSignal;
}

export type ContentKind = "html" | "markdown" | "text" | "json";

export interface FetchedPage {
	/** URL after redirects. */
	url: string;
	status: number;
	contentType: string;
	kind: ContentKind;
	title?: string;
	/** Readable text (Markdown for HTML pages). */
	text: string;
	/** Number of redirects followed. */
	redirects: number;
	/** True when the body hit `maxBytes` and was cut off. */
	bodyTruncated: boolean;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function mediaType(contentType: string): string {
	return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

function charsetOf(contentType: string): string | undefined {
	return /charset\s*=\s*"?([^;"\s]+)/i.exec(contentType)?.[1];
}

export function classifyContent(contentType: string, sample: string): ContentKind | undefined {
	const type = mediaType(contentType);
	if (type === "text/html" || type === "application/xhtml+xml") return "html";
	if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
	if (type === "application/json" || type.endsWith("+json") || type === "text/json") return "json";
	if (type === "text/plain" || type === "") {
		// Servers often mislabel; sniff obvious HTML.
		if (/^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(sample)) return "html";
		if (type === "" && /^\s*[[{]/.test(sample)) return "json";
		return "text";
	}
	if (type.startsWith("text/") || type === "application/xml" || type.endsWith("+xml") || type === "application/javascript") return "text";
	return undefined;
}

function decodeBody(bytes: Uint8Array, contentType: string, kind: ContentKind | undefined): string {
	let charset = charsetOf(contentType);
	if (!charset && kind === "html") {
		// Peek at the first KiB for a <meta charset> declaration.
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
		charset = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}

async function readCapped(res: FetchResponseLike, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of res.body) {
		if (total + chunk.byteLength > maxBytes) {
			chunks.push(chunk.subarray(0, maxBytes - total));
			total = maxBytes;
			truncated = true;
			break; // exiting the loop cancels the stream
		}
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const out = new Uint8Array(total);
	let off = 0;
	for (const c of chunks) {
		out.set(c, off);
		off += c.byteLength;
	}
	return { bytes: out, truncated };
}

/** GET a page, following up to MAX_REDIRECTS redirects (each hop re-checked against the policy). */
export async function fetchPage(rawUrl: string, cfg: FetchConfig, deps: FetchDeps): Promise<FetchedPage> {
	const timeoutMs = cfg.timeoutMs ?? FETCH_DEFAULTS.timeoutMs;
	const maxBytes = cfg.maxBytes ?? FETCH_DEFAULTS.maxBytes;
	const signals = [AbortSignal.timeout(timeoutMs)];
	if (deps.signal) signals.push(deps.signal);
	const signal = AbortSignal.any(signals);

	let url = await checkUrl(rawUrl, cfg, deps);
	let redirects = 0;
	for (;;) {
		let res: FetchResponseLike;
		try {
			res = await deps.fetch(url.href, {
				method: "GET",
				redirect: "manual",
				signal,
				headers: {
					"User-Agent": cfg.userAgent ?? FETCH_DEFAULTS.userAgent,
					Accept: "text/html, application/xhtml+xml, text/markdown, text/plain, application/json;q=0.9, */*;q=0.5",
					"Accept-Language": "en",
				},
			});
		} catch (e) {
			if (signal.aborted) {
				throw new Error(deps.signal?.aborted ? "fetch cancelled" : `timed out after ${timeoutMs} ms fetching ${url.href}`);
			}
			throw new Error(`could not fetch ${url.href}: ${errorMessage(e)}`);
		}
		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get("location");
			if (!location) throw new Error(`HTTP ${res.status} from ${url.href} without a Location header`);
			if (++redirects > MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS}) starting from ${rawUrl}`);
			let next: string;
			try {
				next = new URL(location, url).href;
			} catch {
				throw new Error(`invalid redirect target "${location}" from ${url.href}`);
			}
			url = await checkUrl(next, cfg, deps);
			continue;
		}
		const contentType = res.headers.get("content-type") ?? "";
		if (!res.ok) {
			// Still read a little of the body so the model sees the server's message.
			const { bytes } = await readCapped(res, 2048);
			const snippet = decodeBody(bytes, contentType, "text").replace(/\s+/g, " ").trim().slice(0, 300);
			throw new Error(`HTTP ${res.status} from ${url.href}${snippet ? `: ${snippet}` : ""}`);
		}
		const { bytes, truncated } = await readCapped(res, maxBytes);
		const sample = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
		const kind = classifyContent(contentType, sample);
		if (!kind) {
			throw new Error(`unsupported content type "${mediaType(contentType) || "unknown"}" at ${url.href}; web_fetch handles HTML, Markdown, plain text and JSON`);
		}
		const raw = decodeBody(bytes, contentType, kind);
		let text = raw;
		let title: string | undefined;
		if (kind === "html") {
			const converted = htmlToMarkdown(raw, res.url || url.href);
			text = converted.markdown;
			title = converted.title;
		} else if (kind === "json" && !truncated) {
			try {
				text = JSON.stringify(JSON.parse(raw), null, 2);
			} catch {
				/* leave as served */
			}
		}
		return { url: res.url || url.href, status: res.status, contentType: contentType || "unknown", kind, title, text, redirects, bodyTruncated: truncated };
	}
}

// ---------------------------------------------------------------------------
// HTML -> Markdown
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, number> = {
	amp: 0x26,
	lt: 0x3c,
	gt: 0x3e,
	quot: 0x22,
	apos: 0x27,
	nbsp: 0xa0,
	copy: 0xa9,
	reg: 0xae,
	trade: 0x2122,
	deg: 0xb0,
	plusmn: 0xb1,
	middot: 0xb7,
	laquo: 0xab,
	raquo: 0xbb,
	times: 0xd7,
	divide: 0xf7,
	ndash: 0x2013,
	mdash: 0x2014,
	lsquo: 0x2018,
	rsquo: 0x2019,
	ldquo: 0x201c,
	rdquo: 0x201d,
	bull: 0x2022,
	hellip: 0x2026,
	larr: 0x2190,
	rarr: 0x2192,
	uarr: 0x2191,
	darr: 0x2193,
	euro: 0x20ac,
	pound: 0xa3,
	yen: 0xa5,
	cent: 0xa2,
	sect: 0xa7,
	para: 0xb6,
	iexcl: 0xa1,
	iquest: 0xbf,
	frac12: 0xbd,
	frac14: 0xbc,
	frac34: 0xbe,
	shy: 0xad,
	ensp: 0x2002,
	emsp: 0x2003,
	thinsp: 0x2009,
	zwnj: 0x200c,
	zwj: 0x200d,
	check: 0x2713,
	hearts: 0x2665,
};

export function decodeEntities(s: string): string {
	if (!s.includes("&")) return s;
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
		let cp: number | undefined;
		if (body[0] === "#") {
			cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
		} else {
			cp = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
		}
		if (cp === undefined || !Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
		if (cp === 0) return "";
		return String.fromCodePoint(cp);
	});
}

/** Elements whose entire subtree is noise for a reader. */
const SKIP = new Set([
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	"math",
	"head",
	"iframe",
	"object",
	"embed",
	"canvas",
	"video",
	"audio",
	"nav",
	"footer",
	"aside",
	"button",
	"select",
	"input",
	"textarea",
	"dialog",
	"menu",
]);
/** Block-level elements (besides those handled specially): a paragraph break before and after. */
const BLOCK = new Set(["p", "div", "section", "article", "main", "body", "html", "header", "dl", "figure", "figcaption", "address", "details", "summary", "fieldset", "legend", "center", "thead", "tbody", "tfoot"]);
/** Block elements that get a single line break rather than a blank line. */
const TIGHT = new Set(["div", "header", "figcaption", "summary", "legend", "thead", "tbody", "tfoot"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<\/([a-zA-Z][\w:-]*)[^>]*>|<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|[^<]+|</g;

function attr(attrs: string, name: string): string | undefined {
	const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
	if (!m) return undefined;
	return decodeEntities(m[1] ?? m[2] ?? m[3] ?? "");
}

function hasBooleanAttr(attrs: string, name: string): boolean {
	return new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`, "i").test(attrs) && !new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']?(false|until-found)`, "i").test(attrs);
}

/** Index range of the inner HTML of the first `<tag>` element, honouring nesting. */
function regionOf(html: string, tag: string): [number, number] | undefined {
	const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "i").exec(html);
	if (!open) return undefined;
	const start = open.index + open[0].length;
	const re = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "gi");
	re.lastIndex = start;
	let depth = 1;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		depth += m[1] ? -1 : 1;
		if (depth === 0) return [start, m.index];
	}
	return [start, html.length];
}

/** `<main>` when present, else a lone `<article>`, else `<body>`, else the whole document. */
export function mainRegion(html: string): string {
	const main = regionOf(html, "main");
	if (main) return html.slice(main[0], main[1]);
	const articles = html.match(/<article[\s>]/gi)?.length ?? 0;
	if (articles === 1) {
		const article = regionOf(html, "article");
		if (article) return html.slice(article[0], article[1]);
	}
	const body = regionOf(html, "body");
	return body ? html.slice(body[0], body[1]) : html;
}

export interface Converted {
	title?: string;
	markdown: string;
}

const isBlankLine = (line: string): boolean => /^(>\s*)*$/.test(line);

/**
 * Hand-written HTML to Markdown: drops scripts, styles, navigation and other chrome; prefers the
 * `<main>`/`<article>` region when the page has one; renders headings, lists, links, code, tables
 * and blockquotes. Good enough for reading, not a spec-compliant parser.
 */
export function htmlToMarkdown(html: string, baseUrl?: string): Converted {
	const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = titleMatch ? decodeEntities(titleMatch[1] ?? "").replace(/\s+/g, " ").trim() || undefined : undefined;
	const body = mainRegion(html);

	const lines: string[] = [];
	let cur = "";
	let skipTag: string | undefined;
	let skipDepth = 0;
	let preDepth = 0;
	let preStart = false;
	let quoteDepth = 0;
	const lists: { ordered: boolean; index: number }[] = [];
	const links: { href: string; line: number; col: number }[] = [];
	let row: { cells: number; header: boolean } | undefined;
	let tableRows = 0;
	let wroteAny = false;

	const prefix = () => "> ".repeat(quoteDepth);
	const curIsBlank = () => isBlankLine(cur);
	const flushLine = () => {
		if (!curIsBlank()) wroteAny = true;
		lines.push(cur.replace(/[ \t]+$/, ""));
		cur = prefix();
	};
	const emit = (s: string) => {
		if (!s) return;
		const parts = s.split("\n");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) flushLine();
			cur += parts[i] as string;
		}
	};
	/** Starts a new line, with `blank` blank lines before it. Blank lines keep the quote prefix. */
	const blockBreak = (blank = 1) => {
		if (!curIsBlank()) flushLine();
		if (!wroteAny) return; // nothing written yet
		let trailing = 0;
		for (let i = lines.length - 1; i >= 0 && isBlankLine(lines[i] as string); i--) trailing++;
		while (trailing < blank) {
			lines.push(prefix().trimEnd());
			trailing++;
		}
	};
	const emitText = (raw: string) => {
		let text = raw.replace(/\s+/g, " ");
		if (curIsBlank() || cur.endsWith(" ")) text = text.replace(/^ /, "");
		if (text) cur += text;
	};
	const resolve = (href: string): string => {
		try {
			return baseUrl ? new URL(href, baseUrl).href : href;
		} catch {
			return href;
		}
	};

	for (let m = TOKEN.exec(body); m; m = TOKEN.exec(body)) {
		const token = m[0];
		if (token === "<") {
			if (!skipTag) emitText("<");
			continue;
		}
		if (token.startsWith("<!") || token.startsWith("<?")) continue;
		const closing = m[1]?.toLowerCase();
		const opening = m[2]?.toLowerCase();

		if (skipTag) {
			if (opening === skipTag && !VOID.has(skipTag)) skipDepth++;
			else if (closing === skipTag && --skipDepth === 0) skipTag = undefined;
			continue;
		}

		if (opening) {
			let attrs = m[3] ?? "";
			const selfClosing = /\/\s*$/.test(attrs) || VOID.has(opening);
			attrs = attrs.replace(/\/\s*$/, "");
			if (SKIP.has(opening) || hasBooleanAttr(attrs, "hidden") || /(?:^|\s)aria-hidden\s*=\s*["']?true/i.test(attrs)) {
				if (!selfClosing) {
					skipTag = opening;
					skipDepth = 1;
				}
				continue;
			}
			if (row && opening !== "td" && opening !== "th" && opening !== "tr" && (BLOCK.has(opening) || opening === "br" || opening === "p" || opening === "li" || opening === "ul" || opening === "ol")) {
				emitText(" "); // keep a table row on one line
				continue;
			}
			switch (opening) {
				case "br":
					flushLine();
					break;
				case "hr":
					blockBreak();
					emit("---");
					blockBreak();
					break;
				case "img": {
					const alt = attr(attrs, "alt")?.trim();
					if (alt) emitText(`[image: ${alt}]`);
					break;
				}
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
					blockBreak();
					emit(`${"#".repeat(Number(opening[1]))} `);
					break;
				case "pre":
					blockBreak();
					emit("```");
					flushLine();
					preDepth++;
					preStart = true;
					break;
				case "code":
					if (preDepth === 0) emit("`");
					break;
				case "blockquote":
					blockBreak();
					quoteDepth++;
					cur = prefix();
					break;
				case "ul":
				case "ol":
					blockBreak(lists.length ? 0 : 1);
					lists.push({ ordered: opening === "ol", index: Number(attr(attrs, "start") ?? 1) - 1 });
					break;
				case "li": {
					blockBreak(0);
					const list = lists[lists.length - 1] ?? { ordered: false, index: 0 };
					list.index++;
					emit(`${"  ".repeat(Math.max(0, lists.length - 1))}${list.ordered ? `${list.index}.` : "-"} `);
					break;
				}
				case "table":
					blockBreak();
					tableRows = 0;
					break;
				case "tr":
					blockBreak(0);
					row = { cells: 0, header: false };
					emit("|");
					break;
				case "td":
				case "th":
					if (!row) {
						blockBreak(0);
						row = { cells: 0, header: false };
						emit("|");
					}
					row.cells++;
					if (opening === "th") row.header = true;
					emit(" ");
					break;
				case "a": {
					const href = attr(attrs, "href")?.trim();
					const usable = href && !/^(javascript:|#|data:)/i.test(href) ? resolve(href) : "";
					links.push({ href: usable, line: lines.length, col: cur.length });
					break;
				}
				case "dt":
					blockBreak(0);
					emit("**");
					break;
				case "dd":
					blockBreak(0);
					emit(": ");
					break;
				default:
					if (BLOCK.has(opening)) blockBreak(TIGHT.has(opening) ? 0 : 1);
			}
			continue;
		}

		if (closing) {
			if (row && closing !== "td" && closing !== "th" && closing !== "tr" && closing !== "table" && (BLOCK.has(closing) || closing === "p" || closing === "li" || closing === "ul" || closing === "ol")) {
				emitText(" ");
				continue;
			}
			switch (closing) {
				case "h1":
				case "h2":
				case "h3":
				case "h4":
				case "h5":
				case "h6":
					blockBreak();
					break;
				case "pre":
					if (preDepth > 0) preDepth--;
					if (!curIsBlank()) flushLine();
					emit("```");
					blockBreak();
					break;
				case "code":
					if (preDepth === 0) {
						if (cur.endsWith("`")) cur = cur.slice(0, -1); // drop empty `` pairs
						else emit("`");
					}
					break;
				case "blockquote":
					if (quoteDepth > 0) quoteDepth--;
					if (!curIsBlank()) flushLine();
					while (lines.length && isBlankLine(lines[lines.length - 1] as string)) lines.pop(); // no dangling ">" line
					cur = prefix();
					blockBreak();
					break;
				case "ul":
				case "ol":
					lists.pop();
					blockBreak(lists.length ? 0 : 1);
					break;
				case "td":
				case "th":
					cur = cur.replace(/ +$/, "");
					emit(" |");
					break;
				case "tr":
					if (row) {
						tableRows++;
						if (row.header && tableRows === 1) {
							flushLine();
							emit(`|${" --- |".repeat(row.cells)}`);
						}
						row = undefined;
					}
					blockBreak(0);
					break;
				case "table":
					row = undefined;
					blockBreak();
					break;
				case "a": {
					const link = links.pop();
					if (!link || !link.href) break;
					if (link.line !== lines.length) {
						// The link text spans lines; append the target instead of wrapping it.
						emitText(` <${link.href}>`);
						break;
					}
					const text = cur.slice(link.col);
					const label = text.replace(/\s+/g, " ").trim();
					cur = cur.slice(0, link.col);
					if (!label) emitText(link.href);
					else if (label === link.href || label === link.href.replace(/^https?:\/\//, "").replace(/\/$/, "")) emitText(`<${link.href}>`);
					else cur += `${text.startsWith(" ") && !cur.endsWith(" ") && cur.trim() ? " " : ""}[${label}](${link.href})${text.endsWith(" ") ? " " : ""}`;
					break;
				}
				case "dt":
					emit("**");
					break;
				default:
					if (BLOCK.has(closing)) blockBreak(TIGHT.has(closing) ? 0 : 1);
			}
			continue;
		}

		// Text node
		const text = decodeEntities(token);
		if (preDepth > 0) {
			emit(preStart ? text.replace(/^\r?\n/, "") : text);
			preStart = false;
			continue;
		}
		emitText(text);
	}
	flushLine();

	const out: string[] = [];
	for (const line of lines) {
		if (isBlankLine(line) && (out.length === 0 || isBlankLine(out[out.length - 1] as string))) continue;
		out.push(line);
	}
	while (out.length && isBlankLine(out[out.length - 1] as string)) out.pop();
	return { title, markdown: out.join("\n") };
}

// ---------------------------------------------------------------------------
// Truncation and formatting
// ---------------------------------------------------------------------------

export interface Truncated {
	text: string;
	truncated: boolean;
	shown: number;
	total: number;
}

/** Cuts at `maxChars`, preferring a line boundary in the last 10% so Markdown structure survives. */
export function truncateText(text: string, maxChars: number): Truncated {
	if (text.length <= maxChars) return { text, truncated: false, shown: text.length, total: text.length };
	let cut = maxChars;
	const nl = text.lastIndexOf("\n", maxChars);
	if (nl > maxChars * 0.9) cut = nl;
	return { text: text.slice(0, cut).trimEnd(), truncated: true, shown: cut, total: text.length };
}

export interface FetchReport {
	page: FetchedPage;
	body: Truncated;
	/** Where the full text was written when `body.truncated`. */
	fullTextPath?: string;
	maxChars: number;
}

export function formatFetchResult(r: FetchReport): string {
	const lines = [`URL: ${r.page.url}`, `Content-Type: ${r.page.contentType}`];
	if (r.page.title) lines.push(`Title: ${r.page.title}`);
	if (r.page.redirects) lines.push(`Redirects: ${r.page.redirects}`);
	lines.push("", r.body.text || "(no readable text)");
	const notes: string[] = [];
	if (r.page.bodyTruncated) notes.push("The server response exceeded the download size limit; content past that point is missing.");
	if (r.body.truncated) {
		notes.push(
			`Showing ${r.body.shown.toLocaleString("en-US")} of ${r.body.total.toLocaleString("en-US")} characters (maxChars=${r.maxChars}).` +
				(r.fullTextPath ? ` The full text is saved at ${r.fullTextPath}; read it with the read tool if you need the rest.` : ""),
		);
	}
	if (notes.length) lines.push("", `[Truncated: ${notes.join(" ")}]`);
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchRequest {
	url: string;
	init: FetchInit;
}

export function resolveSearchConfig(cfg: SearchConfig | undefined): { provider: Provider; apiKeyEnv: string; count: number; endpoint: string } {
	const provider = cfg?.provider ?? "brave";
	return {
		provider,
		apiKeyEnv: cfg?.apiKeyEnv ?? DEFAULT_KEY_ENV[provider],
		count: cfg?.count ?? DEFAULT_SEARCH_COUNT,
		endpoint: cfg?.endpoint ?? DEFAULT_ENDPOINT[provider],
	};
}

/** Builds the provider request; the key is only ever placed in a header or the JSON body, never the URL. */
export function buildSearchRequest(provider: Provider, endpoint: string, apiKey: string, query: string, count: number, signal?: AbortSignal): SearchRequest {
	const n = Math.min(Math.max(1, Math.floor(count)), MAX_SEARCH_COUNT);
	if (provider === "brave") {
		const url = new URL(endpoint);
		url.searchParams.set("q", query);
		url.searchParams.set("count", String(n));
		url.searchParams.set("text_decorations", "false");
		return {
			url: url.href,
			init: { method: "GET", headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": apiKey }, signal },
		};
	}
	return {
		url: endpoint,
		init: {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ query, max_results: n, search_depth: "basic", include_answer: false }),
			signal,
		},
	};
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/** Normalises a provider response body to SearchResult[]; unknown shapes yield []. */
export function parseSearchResponse(provider: Provider, json: unknown): SearchResult[] {
	if (!isPlainObject(json)) return [];
	let items: unknown[] = [];
	if (provider === "brave") {
		const web = json.web;
		if (isPlainObject(web) && Array.isArray(web.results)) items = web.results;
	} else if (Array.isArray(json.results)) {
		items = json.results;
	}
	const out: SearchResult[] = [];
	for (const it of items) {
		if (!isPlainObject(it)) continue;
		const url = str(it.url);
		if (!/^https?:\/\//i.test(url)) continue;
		const snippet = decodeEntities(str(it.description) || str(it.content) || str(it.snippet))
			.replace(/<[^>]+>/g, "")
			.replace(/\s+/g, " ")
			.trim();
		out.push({ title: decodeEntities(str(it.title)).replace(/\s+/g, " ").trim() || url, url, snippet });
	}
	return out;
}

export interface SearchDeps {
	fetch: FetchLike;
	env: Record<string, string | undefined>;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function searchWeb(query: string, count: number | undefined, cfg: SearchConfig | undefined, deps: SearchDeps): Promise<SearchResult[]> {
	const q = query.trim();
	if (!q) throw new Error("query must not be empty");
	const resolved = resolveSearchConfig(cfg);
	const apiKey = deps.env[resolved.apiKeyEnv]?.trim();
	if (!apiKey) {
		throw new Error(
			`web_search needs an API key: set the ${resolved.apiKeyEnv} environment variable (${resolved.provider} provider). ` +
				`Change the provider or variable name under "search" in ~/.pi/agent/web-tools.json.`,
		);
	}
	const signals = [AbortSignal.timeout(deps.timeoutMs ?? FETCH_DEFAULTS.timeoutMs)];
	if (deps.signal) signals.push(deps.signal);
	const req = buildSearchRequest(resolved.provider, resolved.endpoint, apiKey, q, count ?? resolved.count, AbortSignal.any(signals));
	let res: FetchResponseLike;
	try {
		res = await deps.fetch(req.url, req.init);
	} catch (e) {
		if (deps.signal?.aborted) throw new Error("search cancelled");
		throw new Error(`could not reach ${resolved.provider} search API: ${errorMessage(e)}`);
	}
	const text = await res.text();
	if (!res.ok) {
		const hint = res.status === 401 || res.status === 403 ? ` (check ${resolved.apiKeyEnv})` : res.status === 429 ? " (rate limited or quota exhausted)" : "";
		throw new Error(`${resolved.provider} search API returned HTTP ${res.status}${hint}: ${text.replace(/\s+/g, " ").trim().slice(0, 300)}`);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`${resolved.provider} search API returned non-JSON: ${text.slice(0, 200)}`);
	}
	return parseSearchResponse(resolved.provider, json);
}

export function formatSearchResults(query: string, results: SearchResult[], provider: Provider, snippetChars = 400): string {
	if (!results.length) return `No results from ${provider} for "${query}".`;
	const blocks = results.map((r, i) => {
		const snippet = r.snippet.length > snippetChars ? `${r.snippet.slice(0, snippetChars - 1).trimEnd()}…` : r.snippet;
		return [`${i + 1}. ${r.title}`, `   ${r.url}`, snippet ? `   ${snippet}` : undefined].filter(Boolean).join("\n");
	});
	return [`${results.length} result${results.length === 1 ? "" : "s"} from ${provider} for "${query}":`, "", ...blocks, "", "Snippets are excerpts; call web_fetch on a URL before quoting or relying on its content."].join("\n");
}
