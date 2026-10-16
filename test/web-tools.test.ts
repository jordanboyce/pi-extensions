import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
	buildSearchRequest,
	checkUrl,
	classifyContent,
	decodeEntities,
	fetchPage,
	formatFetchResult,
	formatSearchResults,
	hostMatches,
	hostPolicyError,
	htmlToMarkdown,
	isPrivateAddress,
	mainRegion,
	parseSearchResponse,
	resolveSearchConfig,
	searchWeb,
	truncateText,
	validateConfig,
	type FetchLike,
	type FetchedPage,
} from "../extensions/web-tools/web.ts";

const realFetch = fetch as unknown as FetchLike;
/** DNS stub: "public.test" is a public address, "internal.test" is RFC 1918, anything else is unknown. */
const lookup = async (host: string): Promise<string[]> => {
	if (host === "public.test") return ["93.184.216.34"];
	if (host === "internal.test") return ["93.184.216.34", "10.1.2.3"];
	if (host === "v6.test") return ["fd00::1"];
	throw new Error(`ENOTFOUND ${host}`);
};
const noLookup = async (host: string): Promise<string[]> => {
	throw new Error(`unexpected DNS lookup for ${host}`);
};

describe("config", () => {
	it("accepts a full config and defaults an empty one", () => {
		assert.ok(validateConfig({}).config);
		assert.ok(
			validateConfig({
				fetch: { timeoutMs: 5000, maxBytes: 100_000, maxChars: 20_000, allowPrivate: true, allow: ["*.example.com"], deny: ["ads.example.com"], userAgent: "x" },
				search: { provider: "tavily", apiKeyEnv: "MY_KEY", count: 8, endpoint: "https://proxy.test/search" },
			}).config,
		);
	});
	it("rejects malformed fields with a pointer to the key", () => {
		assert.match(validateConfig([]).error ?? "", /JSON object/);
		assert.match(validateConfig({ fetch: { timeoutMs: 10 } }).error ?? "", /fetch\.timeoutMs/);
		assert.match(validateConfig({ fetch: { allow: "example.com" } }).error ?? "", /fetch\.allow/);
		assert.match(validateConfig({ fetch: { allowPrivate: "yes" } }).error ?? "", /allowPrivate/);
		assert.match(validateConfig({ fetch: { bogus: 1 } }).error ?? "", /unknown key fetch\.bogus/);
		assert.match(validateConfig({ search: { provider: "google" } }).error ?? "", /search\.provider/);
		assert.match(validateConfig({ search: { apiKeyEnv: "has space" } }).error ?? "", /apiKeyEnv/);
		assert.match(validateConfig({ search: { count: 50 } }).error ?? "", /search\.count/);
		assert.match(validateConfig({ search: { endpoint: "ftp://x" } }).error ?? "", /endpoint/);
		assert.match(validateConfig({ serach: {} }).error ?? "", /unknown key "serach"/);
	});
	it("resolves provider defaults", () => {
		assert.deepEqual(resolveSearchConfig(undefined), { provider: "brave", apiKeyEnv: "BRAVE_SEARCH_API_KEY", count: 5, endpoint: "https://api.search.brave.com/res/v1/web/search" });
		assert.equal(resolveSearchConfig({ provider: "tavily" }).apiKeyEnv, "TAVILY_API_KEY");
		assert.equal(resolveSearchConfig({ provider: "tavily", apiKeyEnv: "K" }).apiKeyEnv, "K");
	});
});

describe("host policy", () => {
	it("globs match whole host names, case-insensitively", () => {
		assert.ok(hostMatches("docs.example.com", ["*.example.com"]));
		assert.ok(!hostMatches("example.com", ["*.example.com"]));
		assert.ok(hostMatches("example.com", ["*.example.com", "example.com"]));
		assert.ok(hostMatches("EXAMPLE.COM.", ["example.com"]));
		assert.ok(!hostMatches("evilexample.com", ["example.com"]));
		assert.ok(!hostMatches("example.com.evil.test", ["example.com"]));
		assert.ok(hostMatches("anything.test", ["*"]));
	});
	it("deny wins over allow; allow list restricts when non-empty", () => {
		assert.equal(hostPolicyError("a.example.com", { allow: ["*.example.com"], deny: ["a.example.com"] }), 'host "a.example.com" is on the deny list');
		assert.equal(hostPolicyError("other.test", { allow: ["*.example.com"] }), 'host "other.test" is not on the allow list');
		assert.equal(hostPolicyError("b.example.com", { allow: ["*.example.com"], deny: ["a.example.com"] }), undefined);
		assert.equal(hostPolicyError("anything", {}), undefined);
	});
	it("classifies private, loopback, link-local and mapped addresses", () => {
		for (const ip of ["127.0.0.1", "127.8.8.8", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1", "fe80::1%eth0", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "ff02::1"]) {
			assert.ok(isPrivateAddress(ip), `${ip} should be private`);
		}
		for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "172.15.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "2001:db8::1"]) {
			assert.ok(!isPrivateAddress(ip), `${ip} should be public`);
		}
	});
	it("checkUrl refuses bad schemes, credentials, local names and private targets", async () => {
		const cfg = {};
		await assert.rejects(checkUrl("ftp://example.com/x", cfg, { lookup: noLookup }), /only http and https/);
		await assert.rejects(checkUrl("file:///etc/passwd", cfg, { lookup: noLookup }), /only http and https/);
		await assert.rejects(checkUrl("javascript:alert(1)", cfg, { lookup: noLookup }), /only http and https/);
		await assert.rejects(checkUrl("not a url", cfg, { lookup: noLookup }), /invalid URL/);
		await assert.rejects(checkUrl("https://user:pw@example.com/", cfg, { lookup: noLookup }), /embedded credentials/);
		await assert.rejects(checkUrl("http://localhost:3000/", cfg, { lookup: noLookup }), /local host name/);
		await assert.rejects(checkUrl("http://app.localhost/", cfg, { lookup: noLookup }), /local host name/);
		await assert.rejects(checkUrl("http://127.0.0.1/", cfg, { lookup: noLookup }), /private address 127\.0\.0\.1/);
		await assert.rejects(checkUrl("http://[::1]:8080/", cfg, { lookup: noLookup }), /private address ::1/);
		await assert.rejects(checkUrl("http://169.254.169.254/latest/meta-data", cfg, { lookup: noLookup }), /private address/);
		await assert.rejects(checkUrl("http://internal.test/", cfg, { lookup }), /resolves to private address 10\.1\.2\.3/);
		await assert.rejects(checkUrl("http://v6.test/", cfg, { lookup }), /resolves to private address fd00::1/);
		await assert.rejects(checkUrl("http://nope.test/", cfg, { lookup }), /could not resolve nope\.test/);
		assert.equal((await checkUrl("https://public.test/a?b=1", cfg, { lookup })).href, "https://public.test/a?b=1");
	});
	it("allowPrivate skips the address check but not the scheme or list checks", async () => {
		assert.equal((await checkUrl("http://127.0.0.1:1234/x", { allowPrivate: true }, { lookup: noLookup })).hostname, "127.0.0.1");
		assert.equal((await checkUrl("http://localhost/", { allowPrivate: true }, { lookup: noLookup })).hostname, "localhost");
		await assert.rejects(checkUrl("ftp://127.0.0.1/", { allowPrivate: true }, { lookup: noLookup }), /only http/);
		await assert.rejects(checkUrl("http://127.0.0.1/", { allowPrivate: true, deny: ["127.*"] }, { lookup: noLookup }), /deny list/);
		await assert.rejects(checkUrl("https://public.test/", { allow: ["*.example.com"] }, { lookup: noLookup }), /not on the allow list/);
	});
});

describe("html to markdown", () => {
	it("decodes entities, including numeric and unknown ones left alone", () => {
		assert.equal(decodeEntities("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x41;&#66; &hellip; &nbsp;x &bogus; &amp"), `a & b <c> "d" 'e' AB ${String.fromCodePoint(0x2026)} ${String.fromCodePoint(0xa0)}x &bogus; &amp`);
	});
	it("prefers main, then a lone article, then body", () => {
		assert.equal(mainRegion("<body><nav>n</nav><main>M</main><article>a</article></body>"), "M");
		assert.equal(mainRegion("<body><div>x</div><article>A</article></body>"), "A");
		assert.equal(mainRegion("<body><article>1</article><article>2</article></body>").replace(/\s/g, ""), "<article>1</article><article>2</article>");
		assert.equal(mainRegion("<p>no body</p>"), "<p>no body</p>");
		assert.equal(mainRegion("<main><main>inner</main> outer</main>"), "<main>inner</main> outer");
	});
	it("strips chrome and renders headings, paragraphs, lists, links, code, quotes and tables", () => {
		const html = `<!DOCTYPE html><html><head><title> Hello &amp;  World </title><style>p{}</style><script>var s = "<p>not text</p>";</script></head>
<body><header><nav><a href="/">Home</a> | <a href="/about">About</a></nav></header>
<main>
  <h1>Main   heading</h1>
  <p>Para with <a href="/rel/path?a=1&amp;b=2">a link</a>, <code>inline code</code> and <strong>bold</strong> text.<br>Second line.</p>
  <ul><li>one</li><li>two <ul><li>nested</li></ul></li></ul>
  <ol start="3"><li>three</li><li>four</li></ol>
  <pre><code>
const a = 1;
  if (a &lt; 2) { b(); }
</code></pre>
  <blockquote><p>Quoted one.</p><p>Quoted two.</p></blockquote>
  <table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td><p>1</p></td></tr></table>
  <p><a href="https://example.com/">https://example.com/</a> and <a href="#top">anchor</a> and <img alt="A chart" src="x.png"> and <a href="mailto:x@y.z">mail</a></p>
  <div hidden>secret</div><div aria-hidden="true">also hidden</div><template><p>tpl</p></template>
  <dl><dt>Term</dt><dd>Definition</dd></dl>
  <hr/>
  <p>tail &copy; 2026</p>
</main><footer>copyright</footer><aside>related</aside></body></html>`;
		const { title, markdown } = htmlToMarkdown(html, "https://site.test/docs/page.html");
		assert.equal(title, "Hello & World");
		assert.equal(
			markdown,
			[
				"# Main heading",
				"",
				"Para with [a link](https://site.test/rel/path?a=1&b=2), `inline code` and bold text.",
				"Second line.",
				"",
				"- one",
				"- two",
				"  - nested",
				"",
				"3. three",
				"4. four",
				"",
				"```",
				"const a = 1;",
				"  if (a < 2) { b(); }",
				"```",
				"",
				"> Quoted one.",
				">",
				"> Quoted two.",
				"",
				"| Name | Value |",
				"| --- | --- |",
				"| a | 1 |",
				"",
				"<https://example.com/> and anchor and [image: A chart] and [mail](mailto:x@y.z)",
				"",
				"**Term**",
				": Definition",
				"",
				"---",
				"",
				`tail ${String.fromCodePoint(0xa9)} 2026`,
			].join("\n"),
		);
		assert.doesNotMatch(markdown, /Home|About|copyright|related|secret|hidden|not text|tpl|p\{\}/);
	});
	it("copes with sloppy markup: unclosed tags, stray '<', uppercase, attributes with '>' in quotes", () => {
		const { markdown } = htmlToMarkdown(`<P>a < b<P>Second <A HREF="/x" data-x="a>b">Link</A><br/><span>s</span><ul><li>x<li>y</ul>`, "http://h.test/");
		assert.equal(markdown, "a < b\n\nSecond [Link](http://h.test/x)\ns\n\n- x\n- y");
	});
	it("keeps nested skipped elements balanced and does not swallow following text", () => {
		const { markdown } = htmlToMarkdown("<div><nav><ul><nav>deep</nav></ul></nav>after nav</div><script>a</script><p>para</p>");
		assert.equal(markdown, "after nav\n\npara");
	});
	it("returns the title and an empty body for a page without text", () => {
		assert.deepEqual(htmlToMarkdown("<html><head><title>Only</title></head><body><script>x</script></body></html>"), { title: "Only", markdown: "" });
	});
	it("classifies content types, sniffing mislabelled HTML and JSON", () => {
		assert.equal(classifyContent("text/html; charset=utf-8", ""), "html");
		assert.equal(classifyContent("application/xhtml+xml", ""), "html");
		assert.equal(classifyContent("text/markdown", ""), "markdown");
		assert.equal(classifyContent("application/json", ""), "json");
		assert.equal(classifyContent("application/problem+json", ""), "json");
		assert.equal(classifyContent("text/plain", "<!doctype html><html>"), "html");
		assert.equal(classifyContent("text/plain", "just text"), "text");
		assert.equal(classifyContent("", '{"a":1}'), "json");
		assert.equal(classifyContent("text/csv", ""), "text");
		assert.equal(classifyContent("image/png", ""), undefined);
		assert.equal(classifyContent("application/pdf", ""), undefined);
	});
});

describe("truncation and formatting", () => {
	it("truncateText cuts at a nearby line boundary and reports counts", () => {
		assert.deepEqual(truncateText("short", 10), { text: "short", truncated: false, shown: 5, total: 5 });
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
		const t = truncateText(lines, 200);
		assert.ok(t.truncated && t.shown <= 200 && t.shown > 180 && t.total === lines.length);
		assert.ok(!t.text.endsWith("\n") && lines.startsWith(t.text));
		assert.match(lines.slice(t.shown), /^\nline/, "cut lands on a line boundary");
	});
	it("formatFetchResult has a header, the body and truncation notes", () => {
		const page: FetchedPage = { url: "https://a.test/p", status: 200, contentType: "text/html; charset=utf-8", kind: "html", title: "T", text: "x".repeat(1000), redirects: 1, bodyTruncated: true };
		const body = truncateText(page.text, 500);
		const text = formatFetchResult({ page, body, fullTextPath: "/tmp/pi-web-fetch-1/page.md", maxChars: 500 });
		assert.match(text, /^URL: https:\/\/a\.test\/p\nContent-Type: text\/html; charset=utf-8\nTitle: T\nRedirects: 1\n\nx{500}\n\n\[Truncated: /);
		assert.match(text, /download size limit/);
		assert.match(text, /Showing 500 of 1,000 characters \(maxChars=500\)\. The full text is saved at \/tmp\/pi-web-fetch-1\/page\.md/);
		const plain = formatFetchResult({ page: { ...page, title: undefined, redirects: 0, bodyTruncated: false, text: "" }, body: truncateText("", 500), maxChars: 500 });
		assert.equal(plain, "URL: https://a.test/p\nContent-Type: text/html; charset=utf-8\n\n(no readable text)");
	});
	it("formatSearchResults numbers results and reminds the model to fetch", () => {
		const text = formatSearchResults("pi agent", [{ title: "Pi", url: "https://pi.dev/", snippet: "s".repeat(500) }, { title: "", url: "https://x.test/", snippet: "" }], "brave");
		const lines = text.split("\n");
		assert.equal(lines[0], '2 results from brave for "pi agent":');
		assert.equal(lines[2], "1. Pi");
		assert.equal(lines[3], "   https://pi.dev/");
		assert.equal(lines[4]?.length, 3 + 400);
		assert.equal(lines[5], "2. ");
		assert.match(text, /call web_fetch on a URL before quoting/);
		assert.equal(formatSearchResults("q", [], "tavily"), 'No results from tavily for "q".');
	});
});

describe("search providers", () => {
	it("builds Brave GET and Tavily POST requests with the key in a header, never the URL", () => {
		const brave = buildSearchRequest("brave", "https://api.search.brave.com/res/v1/web/search", "secret-key", "pi agent", 7);
		assert.equal(brave.url, "https://api.search.brave.com/res/v1/web/search?q=pi+agent&count=7&text_decorations=false");
		assert.equal(brave.init.method, "GET");
		assert.equal(brave.init.headers?.["X-Subscription-Token"], "secret-key");
		const tavily = buildSearchRequest("tavily", "https://api.tavily.com/search", "secret-key", "pi agent", 99);
		assert.equal(tavily.url, "https://api.tavily.com/search");
		assert.equal(tavily.init.method, "POST");
		assert.equal(tavily.init.headers?.Authorization, "Bearer secret-key");
		assert.deepEqual(JSON.parse(tavily.init.body ?? ""), { query: "pi agent", max_results: 20, search_depth: "basic", include_answer: false });
		assert.ok(!tavily.url.includes("secret") && !brave.url.includes("secret"));
	});
	it("parses provider responses and drops junk", () => {
		const brave = parseSearchResponse("brave", {
			web: { results: [{ title: "A &amp; B", url: "https://a.test/", description: "<strong>bold</strong>  text" }, { title: "no url" }, { url: "ftp://x", title: "bad scheme" }] },
		});
		assert.deepEqual(brave, [{ title: "A & B", url: "https://a.test/", snippet: "bold text" }]);
		const tavily = parseSearchResponse("tavily", { results: [{ title: "", url: "https://t.test/p", content: "c" }] });
		assert.deepEqual(tavily, [{ title: "https://t.test/p", url: "https://t.test/p", snippet: "c" }]);
		assert.deepEqual(parseSearchResponse("brave", { unexpected: true }), []);
		assert.deepEqual(parseSearchResponse("tavily", "nope"), []);
	});
	it("searchWeb fails clearly without a key", async () => {
		await assert.rejects(searchWeb("x", undefined, undefined, { fetch: realFetch, env: {} }), /set the BRAVE_SEARCH_API_KEY environment variable \(brave provider\)/);
		await assert.rejects(searchWeb("x", undefined, { provider: "tavily", apiKeyEnv: "T_KEY" }, { fetch: realFetch, env: { T_KEY: "  " } }), /set the T_KEY environment variable \(tavily provider\)/);
		await assert.rejects(searchWeb("   ", undefined, undefined, { fetch: realFetch, env: { BRAVE_SEARCH_API_KEY: "k" } }), /query must not be empty/);
	});
});

describe("against a local server", () => {
	let server: Server;
	let base: string;
	let port: number;
	const requests: { path: string; headers: IncomingMessage["headers"]; method: string; body: string }[] = [];

	const routes: Record<string, (req: IncomingMessage, res: ServerResponse, body: string) => void> = {
		"/page": (_req, res) => {
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end("<html><head><title>Page</title></head><body><nav>menu</nav><main><h1>Hi</h1><p>Body <a href='/other'>link</a></p></main></body></html>");
		},
		"/redirect1": (_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", "/redirect2");
			res.end();
		},
		"/redirect2": (_req, res) => {
			res.statusCode = 301;
			res.setHeader("location", "page");
			res.end();
		},
		"/loop": (_req, res) => {
			res.statusCode = 307;
			res.setHeader("location", "/loop");
			res.end();
		},
		"/no-location": (_req, res) => {
			res.statusCode = 302;
			res.end();
		},
		"/to-private": (_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", "http://127.0.0.1:1/");
			res.end();
		},
		"/to-public": (_req, res) => {
			res.statusCode = 302;
			res.setHeader("location", "http://public.test/page");
			res.end();
		},
		"/missing": (_req, res) => {
			res.statusCode = 404;
			res.setHeader("content-type", "text/html");
			res.end("<html><body><h1>Not   here</h1></body></html>");
		},
		"/json": (_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end('{"a":1,"b":[1,2]}');
		},
		"/text": (_req, res) => {
			res.setHeader("content-type", "text/plain");
			res.end("plain  text\n  kept");
		},
		"/md": (_req, res) => {
			res.setHeader("content-type", "text/markdown");
			res.end("# Title\n\n- item");
		},
		"/mislabelled": (_req, res) => {
			res.setHeader("content-type", "text/plain");
			res.end("<!DOCTYPE html><html><body><p>really html</p></body></html>");
		},
		"/latin1": (_req, res) => {
			res.setHeader("content-type", "text/html; charset=iso-8859-1");
			res.end(Buffer.from([0x3c, 0x70, 0x3e, 0xe9, 0x3c, 0x2f, 0x70, 0x3e])); // <p>é</p>
		},
		"/meta-charset": (_req, res) => {
			res.setHeader("content-type", "text/html");
			res.end(Buffer.concat([Buffer.from('<html><head><meta charset="iso-8859-1"></head><body><p>'), Buffer.from([0xe9]), Buffer.from("</p></body></html>")]));
		},
		"/binary": (_req, res) => {
			res.setHeader("content-type", "image/png");
			res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		},
		"/big": (_req, res) => {
			res.setHeader("content-type", "text/plain");
			res.end("y".repeat(100_000));
		},
		"/slow": () => {
			/* never answers */
		},
		"/search/brave": (req, res) => {
			if (req.headers["x-subscription-token"] !== "brave-key") {
				res.statusCode = 401;
				res.end('{"message":"bad token"}');
				return;
			}
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ web: { results: [{ title: "R1", url: "https://r1.test/", description: "first" }, { title: "R2", url: "https://r2.test/", description: "second" }] } }));
		},
		"/search/tavily": (req, res, body) => {
			if (req.headers.authorization !== "Bearer tavily-key") {
				res.statusCode = 401;
				res.end("Unauthorized");
				return;
			}
			const parsed = JSON.parse(body);
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ results: Array.from({ length: parsed.max_results }, (_, i) => ({ title: `T${i}`, url: `https://t${i}.test/`, content: `for ${parsed.query}` })) }));
		},
		"/search/down": (_req, res) => {
			res.statusCode = 429;
			res.end("slow down");
		},
		"/search/garbage": (_req, res) => {
			res.end("<html>oops</html>");
		},
	};

	before(async () => {
		server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const body = Buffer.concat(chunks).toString();
			const path = new URL(req.url ?? "/", "http://x").pathname;
			requests.push({ path, headers: req.headers, method: req.method ?? "", body });
			const route = routes[path];
			if (!route) {
				res.statusCode = 404;
				res.end("no route");
				return;
			}
			route(req, res, body);
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		port = (server.address() as AddressInfo).port;
		base = `http://127.0.0.1:${port}`;
	});
	after(() => {
		server.closeAllConnections();
		server.close();
	});

	const local = { allowPrivate: true };
	const deps = { fetch: realFetch, lookup: noLookup };

	it("fetches HTML and converts it, sending a User-Agent", async () => {
		const page = await fetchPage(`${base}/page`, local, deps);
		assert.equal(page.status, 200);
		assert.equal(page.kind, "html");
		assert.equal(page.title, "Page");
		assert.equal(page.url, `${base}/page`);
		assert.equal(page.text, `# Hi\n\nBody [link](${base}/other)`);
		assert.equal(page.redirects, 0);
		assert.equal(page.bodyTruncated, false);
		assert.match(requests.at(-1)?.headers["user-agent"] ?? "", /pi-web-tools/);
	});
	it("follows relative and absolute redirects and reports the final URL", async () => {
		const page = await fetchPage(`${base}/redirect1`, local, deps);
		assert.equal(page.url, `${base}/page`);
		assert.equal(page.redirects, 2);
		assert.equal(page.title, "Page");
	});
	it("stops after 5 redirects and on a redirect without Location", async () => {
		await assert.rejects(fetchPage(`${base}/loop`, local, deps), /too many redirects \(more than 5\)/);
		await assert.rejects(fetchPage(`${base}/no-location`, local, deps), /HTTP 302 .* without a Location header/);
	});
	it("re-checks the policy on every redirect hop", async () => {
		// The DNS stub says public.test is public; the fetch stub routes it to the local server so the redirect itself is real.
		const viaPublicName: FetchLike = (url, init) => realFetch(url.replace("http://public.test/", `${base}/`), init);
		const strict = { fetch: viaPublicName, lookup };
		await assert.rejects(fetchPage("http://public.test/to-private", {}, strict), /refusing private address 127\.0\.0\.1/);
		const ok = await fetchPage("http://public.test/to-public", {}, strict);
		assert.equal(ok.title, "Page");
		await assert.rejects(fetchPage(`${base}/page`, {}, deps), /refusing private address/);
		await assert.rejects(fetchPage("http://public.test/to-public", { deny: ["public.*"] }, strict), /deny list/);
	});
	it("surfaces HTTP errors with a snippet of the body", async () => {
		await assert.rejects(fetchPage(`${base}/missing`, local, deps), new RegExp(`HTTP 404 from ${base}/missing: <html><body><h1>Not here`));
	});
	it("handles JSON, plain text, Markdown and mislabelled HTML", async () => {
		const json = await fetchPage(`${base}/json`, local, deps);
		assert.equal(json.kind, "json");
		assert.equal(json.text, '{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
		const text = await fetchPage(`${base}/text`, local, deps);
		assert.equal(text.kind, "text");
		assert.equal(text.text, "plain  text\n  kept");
		const md = await fetchPage(`${base}/md`, local, deps);
		assert.equal(md.kind, "markdown");
		assert.equal(md.text, "# Title\n\n- item");
		const sniffed = await fetchPage(`${base}/mislabelled`, local, deps);
		assert.equal(sniffed.kind, "html");
		assert.equal(sniffed.text, "really html");
	});
	it("decodes declared and meta charsets", async () => {
		assert.equal((await fetchPage(`${base}/latin1`, local, deps)).text, String.fromCodePoint(0xe9));
		assert.equal((await fetchPage(`${base}/meta-charset`, local, deps)).text, String.fromCodePoint(0xe9));
	});
	it("refuses binary content types", async () => {
		await assert.rejects(fetchPage(`${base}/binary`, local, deps), /unsupported content type "image\/png"/);
	});
	it("caps the download at maxBytes and flags it", async () => {
		const page = await fetchPage(`${base}/big`, { ...local, maxBytes: 10_000 }, deps);
		assert.equal(page.bodyTruncated, true);
		assert.equal(page.text.length, 10_000);
	});
	it("times out and honours an external abort signal", async () => {
		await assert.rejects(fetchPage(`${base}/slow`, { ...local, timeoutMs: 300 }, deps), /timed out after 300 ms/);
		const ac = new AbortController();
		const p = fetchPage(`${base}/slow`, local, { ...deps, signal: ac.signal });
		setTimeout(() => ac.abort(), 50);
		await assert.rejects(p, /fetch cancelled/);
	});
	it("searches Brave through a configured endpoint", async () => {
		const results = await searchWeb("pi", 2, { provider: "brave", endpoint: `${base}/search/brave` }, { fetch: realFetch, env: { BRAVE_SEARCH_API_KEY: "brave-key" } });
		assert.deepEqual(results, [
			{ title: "R1", url: "https://r1.test/", snippet: "first" },
			{ title: "R2", url: "https://r2.test/", snippet: "second" },
		]);
		const last = requests.at(-1);
		assert.equal(last?.method, "GET");
		assert.ok(!JSON.stringify(last?.path).includes("brave-key"));
	});
	it("searches Tavily with the key from a custom env var and clamps count", async () => {
		const results = await searchWeb("pi agent", 3, { provider: "tavily", apiKeyEnv: "MY_TAVILY", endpoint: `${base}/search/tavily` }, { fetch: realFetch, env: { MY_TAVILY: "tavily-key" } });
		assert.equal(results.length, 3);
		assert.equal(results[0]?.snippet, "for pi agent");
		assert.equal(requests.at(-1)?.method, "POST");
		const many = await searchWeb("pi", 500, { provider: "tavily", apiKeyEnv: "MY_TAVILY", endpoint: `${base}/search/tavily` }, { fetch: realFetch, env: { MY_TAVILY: "tavily-key" } });
		assert.equal(many.length, 20);
	});
	it("reports provider errors with hints", async () => {
		await assert.rejects(
			searchWeb("pi", undefined, { provider: "brave", endpoint: `${base}/search/brave` }, { fetch: realFetch, env: { BRAVE_SEARCH_API_KEY: "wrong" } }),
			/brave search API returned HTTP 401 \(check BRAVE_SEARCH_API_KEY\): \{"message":"bad token"\}/,
		);
		await assert.rejects(searchWeb("pi", undefined, { endpoint: `${base}/search/down` }, { fetch: realFetch, env: { BRAVE_SEARCH_API_KEY: "k" } }), /HTTP 429 \(rate limited or quota exhausted\)/);
		await assert.rejects(searchWeb("pi", undefined, { endpoint: `${base}/search/garbage` }, { fetch: realFetch, env: { BRAVE_SEARCH_API_KEY: "k" } }), /returned non-JSON/);
		await assert.rejects(searchWeb("pi", undefined, { endpoint: "http://127.0.0.1:1/" }, { fetch: realFetch, env: { BRAVE_SEARCH_API_KEY: "k" } }), /could not reach brave search API/);
	});
});
