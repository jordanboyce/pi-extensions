import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	entryTags,
	entryTitle,
	fileHeader,
	formatEntry,
	notePath,
	projectNameFromRemote,
	sanitizeFileName,
	sanitizeTag,
	validateConfig,
	type NoteEntry,
} from "../extensions/notes-sync/format.ts";
import { clearJoplinCache, sendToJoplin } from "../extensions/notes-sync/joplin.ts";
import { appendToNote, recentEntries } from "../extensions/notes-sync/store.ts";

const entry = (over: Partial<NoteEntry> = {}): NoteEntry => ({
	kind: "decision",
	text: "Use SQLite for local dev.\nPostgres is overkill here.",
	project: "billing-api",
	branch: "feature/new-ledger",
	date: new Date(2026, 9, 16, 14, 3),
	...over,
});

describe("sanitizers", () => {
	it("sanitizeFileName strips Windows-illegal chars, reserved names and trailing dots", () => {
		assert.equal(sanitizeFileName('a<b>c:d"e/f\\g|h?i*j'), "a-b-c-d-e-f-g-h-i-j");
		assert.equal(sanitizeFileName("CON"), "_CON");
		assert.equal(sanitizeFileName("repo. "), "repo");
		assert.equal(sanitizeFileName("..."), "untitled");
	});
	it("sanitizeTag keeps nested slashes, drops invalid chars, never purely numeric", () => {
		assert.equal(sanitizeTag("feature/new ledger!"), "feature/new-ledger");
		assert.equal(sanitizeTag("2026"), "n2026");
		assert.equal(sanitizeTag("###"), "untagged");
	});
});

describe("formatting", () => {
	it("tags include project, branch, kind and base tags once", () => {
		assert.deepEqual(entryTags(entry(), ["pi", "work"]), ["pi", "work", "decision", "project/billing-api", "branch/feature/new-ledger"]);
		assert.deepEqual(entryTags(entry({ kind: "note" }), ["note"]), ["note", "project/billing-api", "branch/feature/new-ledger"]);
	});
	it("decision entry has heading, metadata, body and tag line", () => {
		const md = formatEntry(entry({ title: "Local DB" }), {}, true);
		assert.match(md, /\n## 2026-10-16 14:03 · decision — Local DB\n/);
		assert.match(md, /\*\*Project:\*\* billing-api · \*\*Branch:\*\* `feature\/new-ledger`/);
		assert.match(md, /Use SQLite for local dev\.\nPostgres is overkill here\./);
		assert.match(md, /#pi #decision #project\/billing-api #branch\/feature\/new-ledger\n$/);
	});
	it("todo is an Obsidian Tasks checkbox: tags, then the created-date field last on the line", () => {
		const md = formatEntry(entry({ kind: "todo", text: "Migrate ledger table\nafter review" }), {}, true);
		assert.equal(md, "\n- [ ] Migrate ledger table #pi #todo #project/billing-api #branch/feature/new-ledger ➕ 2026-10-16\n  after review\n");
		// Daily layout files still carry the created date: Tasks reads it from the line, not the file name.
		assert.match(formatEntry(entry({ kind: "todo", text: "x" }), { layout: "daily" }, false), /➕ 2026-10-16\n$/);
	});
	it("omits branch when not on one", () => {
		assert.doesNotMatch(formatEntry(entry({ branch: undefined }), {}, true), /Branch|branch\//);
	});
	it("title falls back to the first line, truncated", () => {
		assert.equal(entryTitle(entry()), "Use SQLite for local dev.");
		assert.equal(entryTitle(entry({ text: "x".repeat(100) })).length, 70);
	});
	it("project layout vs daily layout paths", () => {
		const dir = join("V", "Pi Notes");
		assert.equal(notePath(dir, {}, entry()), join(dir, "billing-api.md"));
		assert.equal(notePath(dir, { layout: "daily" }, entry()), join(dir, "billing-api", "2026-10-16.md"));
	});
	it("file header has YAML frontmatter", () => {
		const h = fileHeader(entry(), {});
		assert.match(h, /^---\nproject: "billing-api"\ntags: \[pi, project\/billing-api\]\n---\n\n# billing-api — pi notes\n/);
	});
	it("projectNameFromRemote handles ssh and https", () => {
		assert.equal(projectNameFromRemote("git@github.com:Acme/Billing-API.git"), "Billing-API");
		assert.equal(projectNameFromRemote("https://github.com/acme/billing-api/"), "billing-api");
	});
	it("validateConfig rejects non-loopback Joplin host and malformed fields", () => {
		assert.match(validateConfig({ joplin: { host: "evil.example.com" } }).error ?? "", /loopback/);
		assert.ok(validateConfig({ joplin: { host: "localhost", port: 41184, notebook: "Pi Notes" } }).config);
		assert.match(validateConfig({ layout: "weekly" }).error ?? "", /layout/);
		assert.match(validateConfig({ vault: 42 }).error ?? "", /"vault" must be a non-empty string/);
		assert.match(validateConfig({ joplin: { port: "41184" } }).error ?? "", /joplin\.port/);
		assert.match(validateConfig({ joplin: "yes" }).error ?? "", /"joplin" must be an object/);
		assert.match(validateConfig({ modelTool: "true" }).error ?? "", /modelTool/);
		assert.match(validateConfig([]).error ?? "", /JSON object/);
	});
});

describe("store", () => {
	let dir: string;
	after(async () => dir && (await rm(dir, { recursive: true, force: true })));

	it("creates folders + header once, then appends", async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-notes-"));
		const file = join(dir, "nested", "vault", "proj.md");
		await appendToNote(file, "HEADER\n", "\n## one\n");
		await appendToNote(file, "HEADER\n", "\n## two\n");
		await appendToNote(file, "HEADER\n", "\n- [ ] a task\n");
		const text = await readFile(file, "utf8");
		assert.equal(text, "HEADER\n\n## one\n\n## two\n\n- [ ] a task\n");
		assert.deepEqual(await recentEntries(file, 2), ["## two", "- [ ] a task"]);
		await appendToNote(file, "HEADER\n", "\n- [x] done task\n  continuation line\n");
		assert.deepEqual(await recentEntries(file, 2), ["- [ ] a task", "- [x] done task"], "checked todos still count; continuation lines do not");
		assert.deepEqual(await recentEntries(join(dir, "missing.md"), 5), []);
	});

	it("concurrent appends all land", async () => {
		const file = join(dir, "concurrent.md");
		await Promise.all(Array.from({ length: 25 }, (_, i) => appendToNote(file, "H\n", `\n## e${i}\n`)));
		const text = await readFile(file, "utf8");
		assert.equal(text.startsWith("H\n"), true);
		assert.equal(text.match(/^## e\d+$/gm)?.length, 25);
	});
});

describe("joplin client", () => {
	it("creates the notebook once, the note, and attaches tags", async () => {
		const calls: string[] = [];
		const bodies: unknown[] = [];
		const server = createServer(async (req: IncomingMessage, res) => {
			const url = new URL(req.url ?? "", "http://x");
			const chunks: Buffer[] = [];
			for await (const c of req) chunks.push(c as Buffer);
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
			calls.push(`${req.method} ${url.pathname}`);
			if (body) bodies.push(body);
			assert.equal(url.searchParams.get("token"), "tok");
			const send = (o: unknown) => {
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(o));
			};
			if (req.method === "GET" && url.pathname === "/folders") return send({ items: [{ id: "f0", title: "Other" }], has_more: false });
			if (req.method === "POST" && url.pathname === "/folders") return send({ id: "f1", title: body.title });
			if (req.method === "POST" && url.pathname === "/notes") return send({ id: "n1", title: body.title });
			if (req.method === "GET" && url.pathname === "/search") return send({ items: [], has_more: false });
			if (req.method === "POST" && url.pathname === "/tags") return send({ id: `t-${body.title}`, title: body.title });
			if (req.method === "POST" && url.pathname.startsWith("/tags/")) return send({});
			res.statusCode = 404;
			res.end("{}");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		try {
			clearJoplinCache();
			const note = { title: "[decision] Local DB", body: "body", tags: ["pi", "Decision"] };
			const id = await sendToJoplin({ port, notebook: "Pi Notes" }, "tok", note);
			assert.equal(id, "n1");
			await sendToJoplin({ port, notebook: "Pi Notes" }, "tok", note); // folder id is cached
			assert.equal(calls.filter((c) => c === "POST /folders").length, 1);
			assert.equal(calls.filter((c) => c === "POST /notes").length, 2);
			assert.ok(calls.includes("POST /tags/t-decision/notes"), "tags are lower-cased and attached");
			assert.deepEqual(bodies[1], { title: "[decision] Local DB", body: "body", parent_id: "f1" });
		} finally {
			server.close();
		}
	});

	it("surfaces HTTP failures", async () => {
		clearJoplinCache();
		const server = createServer((_req, res) => {
			res.statusCode = 403;
			res.end("{}");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as AddressInfo).port;
		try {
			await assert.rejects(sendToJoplin({ port }, "bad", { title: "t", body: "b", tags: [] }), /HTTP 403/);
		} finally {
			server.close();
		}
	});
});
