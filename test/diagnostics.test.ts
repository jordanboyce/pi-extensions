import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import {
	Coalescer,
	countText,
	DEFAULTS,
	displayPath,
	filterToFile,
	findUp,
	parseOutput,
	pathKey,
	placeholdersIn,
	planCommand,
	renderBlock,
	resolveBinary,
	resolveTarget,
	samePath,
	splitCommand,
	statusText,
	substitute,
	summarize,
	validateConfig,
	type ResolveOptions,
} from "../extensions/diagnostics/checkers.ts";
import diagnostics from "../extensions/diagnostics/index.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("paths", () => {
	it("pathKey folds separators and, on win32, case", () => {
		assert.equal(pathKey("C:\\Repo\\Src\\x.ts", "win32"), "c:/repo/src/x.ts");
		assert.equal(pathKey("C:/repo/src/./x.ts", "win32"), "c:/repo/src/x.ts");
		assert.equal(pathKey("/repo/src/../src/X.ts", "posix"), "/repo/src/X.ts");
		assert.ok(samePath("C:\\Repo\\x.ts", "c:/repo/X.TS", "win32"));
		assert.ok(!samePath("/repo/x.ts", "/repo/X.ts", "posix"));
	});
	it("resolveTarget expands ~ and resolves against cwd", () => {
		assert.equal(resolveTarget("src/x.ts", "/work", "/home/u", "posix"), "/work/src/x.ts");
		assert.equal(resolveTarget("~/notes.py", "/work", "/home/u", "posix"), "/home/u/notes.py");
		assert.equal(resolveTarget("src\\x.ts", "D:\\work", "C:\\Users\\u", "win32"), "D:\\work\\src\\x.ts");
		assert.equal(resolveTarget("C:\\other\\y.go", "D:\\work", "C:\\Users\\u", "win32"), "C:\\other\\y.go");
	});
	it("findUp returns the nearest marker or undefined", () => {
		const files = new Set(["/repo/tsconfig.json", "/repo/pkg/a/tsconfig.json"]);
		const exists = (p: string) => files.has(p);
		assert.equal(findUp("/repo/pkg/a/src/deep", "tsconfig.json", exists, "posix"), "/repo/pkg/a/tsconfig.json");
		assert.equal(findUp("/repo/pkg/b", "tsconfig.json", exists, "posix"), "/repo/tsconfig.json");
		assert.equal(findUp("/elsewhere", "tsconfig.json", exists, "posix"), undefined);
		const winFiles = new Set(["D:\\repo\\go.mod"]);
		assert.equal(findUp("D:\\repo\\cmd\\x", "go.mod", (p) => winFiles.has(p), "win32"), "D:\\repo\\go.mod");
	});
	it("displayPath is cwd-relative with forward slashes, absolute outside cwd", () => {
		assert.equal(displayPath("D:\\repo\\src\\x.ts", "D:\\repo", "win32"), "src/x.ts");
		assert.equal(displayPath("D:\\other\\x.ts", "D:\\repo", "win32"), "D:/other/x.ts");
		assert.equal(displayPath("/repo/src/x.ts", "/repo", "posix"), "src/x.ts");
	});
});

describe("command templating", () => {
	it("splitCommand groups quoted words and drops empty space", () => {
		assert.deepEqual(splitCommand(`tsc -p {marker}   --noEmit`), ["tsc", "-p", "{marker}", "--noEmit"]);
		assert.deepEqual(splitCommand(`"C:\\Program Files\\x\\tool.exe" --flag 'a b' c`), ["C:\\Program Files\\x\\tool.exe", "--flag", "a b", "c"]);
		assert.deepEqual(splitCommand(`  `), []);
	});
	it("substitute keeps a path with spaces as one word and leaves unknown placeholders", () => {
		const vars = { file: "D:\\My Repo\\a b.ts", dir: "D:\\My Repo", root: "D:\\My Repo", marker: "", relfile: "a b.ts", cwd: "D:\\My Repo" };
		assert.equal(substitute("--file={file}", vars), "--file=D:\\My Repo\\a b.ts");
		assert.equal(substitute("{nope}", vars), "{nope}");
		assert.deepEqual(placeholdersIn("x {file} {root}/{relfile} {bad}"), ["file", "root", "relfile", "bad"]);
	});
	it("planCommand uses the marker's directory as root", () => {
		const files = new Set(["D:\\repo\\tsconfig.json"]);
		const plan = planCommand(DEFAULTS.checkers[".ts"]![0]!, {
			file: "D:\\repo\\src\\x.ts",
			cwd: "D:\\elsewhere",
			exists: (p) => files.has(p),
			platform: "win32",
		});
		assert.ok(plan);
		assert.equal(plan.name, "tsc");
		assert.equal(plan.root, "D:\\repo");
		assert.deepEqual(plan.argv, ["tsc", "-p", "D:\\repo\\tsconfig.json", "--noEmit", "--pretty", "false"]);
		assert.equal(plan.format, "tsc");
		assert.equal(plan.filter, true);
	});
	it("planCommand falls back when the marker is missing, or skips when it cannot", () => {
		const none = () => false;
		const fb = planCommand(DEFAULTS.checkers[".ts"]![0]!, { file: "/w/x.ts", cwd: "/w", exists: none, platform: "posix" });
		assert.deepEqual(fb?.argv, ["tsc", "--noEmit", "--pretty", "false", "/w/x.ts"]);
		assert.equal(fb?.root, "/w");
		assert.equal(planCommand({ command: "tool -p {marker}", marker: "cfg.json" }, { file: "/w/x.ts", cwd: "/w", exists: none, platform: "posix" }), undefined);
		const govet = planCommand(DEFAULTS.checkers[".go"]![0]!, { file: "/w/a/x.go", cwd: "/w", exists: none, platform: "posix" });
		assert.deepEqual([govet?.root, govet?.argv, govet?.name], ["/w", ["go", "vet", "./..."], "go vet"]);
	});
	it("planCommand derives the name from the binary and fills relfile/dir", () => {
		const plan = planCommand({ command: "lint {relfile} {dir}" }, { file: "/w/src/x.py", cwd: "/w", exists: () => false, platform: "posix" });
		assert.deepEqual([plan?.name, plan?.argv, plan?.format], ["lint", ["lint", "src/x.py", "/w/src"], "generic"]);
	});
});

describe("resolveBinary", () => {
	const SHIM = `@ECHO off\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\typescript\\bin\\tsc" %*\r\n`;
	function fs(files: Record<string, string | true>) {
		return {
			isFile: (p: string) => p in files,
			readFile: (p: string) => (typeof files[p] === "string" ? (files[p] as string) : undefined),
		};
	}
	it("unwraps a local npm .cmd shim to node + script on win32", () => {
		const opts: ResolveOptions = {
			platform: "win32",
			localDirs: ["D:\\My Repo"],
			env: { Path: "C:\\Windows\\system32", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
			nodePath: "C:\\nodejs\\node.exe",
			...fs({ "D:\\My Repo\\node_modules\\.bin\\tsc.cmd": SHIM, "D:\\My Repo\\node_modules\\typescript\\bin\\tsc": true }),
		};
		assert.deepEqual(resolveBinary("tsc", opts), { command: "C:\\nodejs\\node.exe", args: ["D:\\My Repo\\node_modules\\typescript\\bin\\tsc"], via: "local" });
	});
	it("finds .exe on PATH using PATHEXT, and falls back to cmd.exe for an opaque .cmd", () => {
		const opts: ResolveOptions = {
			platform: "win32",
			localDirs: ["D:\\repo"],
			env: { PATH: "C:\\Go\\bin;C:\\tools", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
			nodePath: "node",
			...fs({ "C:\\Go\\bin\\go.exe": true, "C:\\tools\\weird.cmd": "@echo hi" }),
		};
		assert.deepEqual(resolveBinary("go", opts), { command: "C:\\Go\\bin\\go.exe", args: [], via: "path" });
		assert.deepEqual(resolveBinary("weird", opts), { command: "cmd.exe", args: ["/d", "/c", "C:\\tools\\weird.cmd"], via: "path" });
		assert.equal(resolveBinary("pyright", opts), undefined);
	});
	it("prefers local node_modules/.bin, then PATH, on posix", () => {
		const opts: ResolveOptions = {
			platform: "posix",
			localDirs: ["/repo/pkg", "/repo"],
			env: { PATH: "/usr/local/bin:/usr/bin" },
			nodePath: "/usr/bin/node",
			...fs({ "/repo/node_modules/.bin/tsc": true, "/usr/bin/tsc": true, "/usr/local/bin/pyright": true }),
		};
		assert.deepEqual(resolveBinary("tsc", opts), { command: "/repo/node_modules/.bin/tsc", args: [], via: "local" });
		assert.deepEqual(resolveBinary("pyright", opts), { command: "/usr/local/bin/pyright", args: [], via: "path" });
		assert.equal(resolveBinary("missing", opts), undefined);
	});
	it("resolves an explicit path relative to the project root", () => {
		const opts: ResolveOptions = {
			platform: "posix",
			localDirs: ["/repo"],
			env: {},
			nodePath: "node",
			...fs({ "/repo/scripts/check.sh": true }),
		};
		assert.deepEqual(resolveBinary("./scripts/check.sh", opts), { command: "/repo/scripts/check.sh", args: [], via: "explicit" });
	});
});

describe("parseOutput", () => {
	it("parses tsc --pretty false output, continuation lines and global errors", () => {
		const text = [
			"src/x.ts(12,5): error TS2322: Type 'number' is not assignable to type 'string'.",
			"  Types of property 'a' are incompatible.",
			"src/y.ts(3,1): error TS2304: Cannot find name 'foo'.",
			"error TS5083: Cannot read file 'D:/repo/tsconfig.base.json'.",
			"",
		].join("\r\n");
		const d = parseOutput(text, "tsc", { root: "D:\\repo", platform: "win32" });
		assert.equal(d.length, 3);
		assert.deepEqual(d[0], {
			file: "D:\\repo\\src\\x.ts",
			line: 12,
			col: 5,
			severity: "error",
			code: "TS2322",
			message: "Type 'number' is not assignable to type 'string'. Types of property 'a' are incompatible.",
		});
		assert.equal(d[1]!.file, "D:\\repo\\src\\y.ts");
		assert.deepEqual([d[2]!.file, d[2]!.code, d[2]!.message], [undefined, "TS5083", "Cannot read file 'D:/repo/tsconfig.base.json'."]);
	});
	it("parses pyright text output and extracts the rule", () => {
		const text = [
			"c:\\proj\\x.py",
			"  c:\\proj\\x.py:3:5 - error: \"foo\" is not defined (reportUndefinedVariable)",
			"  c:\\proj\\x.py:4:1 - warning: Import \"os\" is not accessed",
			"1 error, 1 warning, 0 informations ",
		].join("\n");
		const d = parseOutput(text, "pyright", { root: "c:\\proj", platform: "win32" });
		assert.equal(d.length, 2);
		assert.deepEqual(d[0], { file: "c:\\proj\\x.py", line: 3, col: 5, severity: "error", code: "reportUndefinedVariable", message: '"foo" is not defined' });
		assert.deepEqual([d[1]!.severity, d[1]!.code, d[1]!.message], ["warning", undefined, 'Import "os" is not accessed']);
	});
	it("parses generic file:line:col output (pyflakes, go vet) and skips noise", () => {
		const text = [
			"# example.com/mod/pkg",
			"./x.go:5:2: undefined: foo",
			"vet: pkg/y.go:7:1: declared and not used: z",
			"go: downloading something v1.2.3",
			"x.py:3:5 undefined name 'bar'",
			"C:\\proj\\z.py:9:1: warning: unused import",
			"",
		].join("\n");
		const d = parseOutput(text, "generic", { root: "/mod", platform: "posix" });
		assert.equal(d.length, 4);
		assert.deepEqual(d[0], { file: "/mod/x.go", line: 5, col: 2, severity: "error", message: "undefined: foo" });
		assert.equal(d[1]!.file, "/mod/pkg/y.go");
		assert.deepEqual([d[2]!.file, d[2]!.line, d[2]!.col, d[2]!.message], ["/mod/x.py", 3, 5, "undefined name 'bar'"]);
		assert.deepEqual([d[3]!.severity, d[3]!.message], ["warning", "unused import"]);
	});
	it("filterToFile keeps the edited file and file-less diagnostics, case-insensitively on win32", () => {
		const d = parseOutput("src/X.ts(1,1): error TS1: a\nsrc/y.ts(1,1): error TS2: b\nerror TS3: c", "tsc", { root: "D:\\repo", platform: "win32" });
		const kept = filterToFile(d, "d:\\repo\\src\\x.ts", "win32");
		assert.deepEqual(
			kept.map((k) => k.code),
			["TS1", "TS3"],
		);
	});
});

describe("rendering", () => {
	it("renders a capped block with counts and cwd-relative paths", () => {
		const diags = parseOutput(
			["a.ts(1,2): error TS1: one", "a.ts(2,2): warning TS2: two", "a.ts(3,2): error TS3: three"].join("\n"),
			"tsc",
			{ root: "/repo/src", platform: "posix" },
		);
		const block = renderBlock("tsc", diags, { cwd: "/repo", maxLines: 2, platform: "posix" });
		assert.equal(block, ["Diagnostics (tsc): 2 errors, 1 warning", "  src/a.ts:1:2 TS1 one", "  src/a.ts:2:2 warning TS2 two", "  ... 1 more"].join("\n"));
		assert.equal(renderBlock("tsc", [], { cwd: "/repo", maxLines: 2, platform: "posix" }), "");
		assert.equal(renderBlock("tsc", [{ severity: "error", message: "tsc failed: boom" }], { cwd: "/r", maxLines: 5, platform: "posix" }), "Diagnostics (tsc): 1 error\n  (global) tsc failed: boom");
	});
	it("summarize/countText/statusText", () => {
		const c = summarize([{ severity: "error", message: "" }, { severity: "info", message: "" }]);
		assert.deepEqual(c, { errors: 1, warnings: 0, infos: 1 });
		assert.equal(countText(c), "1 error, 1 note");
		assert.equal(countText({ errors: 0, warnings: 0, infos: 0 }), "no errors");
		assert.equal(statusText("tsc", { errors: 0, warnings: 0, infos: 0 }), "diag: tsc ok");
		assert.equal(statusText("tsc", { errors: 2, warnings: 0, infos: 0 }), "diag: tsc 2 errors");
	});
});

describe("validateConfig", () => {
	it("accepts an empty object and merges user checkers over defaults", () => {
		const r = validateConfig({});
		assert.equal(r.error, undefined);
		assert.deepEqual(r.config, { ...DEFAULTS, checkers: { ...DEFAULTS.checkers } });
		const m = validateConfig({
			timeoutMs: "5000",
			checkers: { rs: { command: "cargo check", marker: "Cargo.toml" }, ".TSX": false, ".py": [{ command: "ruff check {file}" }] },
		}).config!;
		assert.equal(m.timeoutMs, 5000);
		assert.deepEqual(m.checkers[".rs"], [{ command: "cargo check", marker: "Cargo.toml" }]);
		assert.equal(m.checkers[".tsx"], undefined);
		assert.deepEqual(m.checkers[".py"], [{ command: "ruff check {file}" }]);
		assert.deepEqual(m.checkers[".ts"], DEFAULTS.checkers[".ts"]);
	});
	it("rejects malformed input with a specific message", () => {
		const bad = (raw: unknown, re: RegExp) => assert.match(validateConfig(raw).error ?? "", re);
		bad([], /JSON object/);
		bad({ timeout: 1 }, /unknown key "timeout"/);
		bad({ enabled: "yes" }, /"enabled"/);
		bad({ maxLines: -1 }, /"maxLines"/);
		bad({ checkers: [] }, /keyed by file extension/);
		bad({ checkers: { "bad ext": { command: "x" } } }, /not a file extension/);
		bad({ checkers: { ".x": {} } }, /"command"/);
		bad({ checkers: { ".x": { command: "x", frmt: "tsc" } } }, /unknown key "frmt"/);
		bad({ checkers: { ".x": { command: "x", format: "eslint" } } }, /"format" must be one of/);
		bad({ checkers: { ".x": { command: "x {fiel}" } } }, /unknown placeholder \{fiel\}/);
		bad({ checkers: { ".x": { command: "x", marker: "m", fallback: "y {marker}" } } }, /cannot use \{marker\}/);
		bad({ checkers: { ".x": { command: "x", fallback: "y" } } }, /needs a "marker"/);
		bad({ checkers: { ".x": [] } }, /empty/);
		bad({ checkers: { ".x": { command: "x", filter: "no" } } }, /"filter"/);
	});
	it("accepts the tracked example file", () => {
		const raw = JSON.parse(readFileSync(join(REPO, "extensions", "diagnostics", "diagnostics.example.json"), "utf8"));
		const r = validateConfig(raw);
		assert.equal(r.error, undefined);
		assert.equal(r.config!.checkers[".tsx"], undefined);
		assert.equal(r.config!.checkers[".rs"]![0]!.timeoutMs, 60000);
	});
});

describe("Coalescer", () => {
	const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
	it("shares one run across a burst and runs again for calls made while running", async () => {
		const c = new Coalescer(20);
		let runs = 0;
		const job = async () => {
			runs++;
			await tick(40);
			return runs;
		};
		const burst = Promise.all([c.run("k", job), c.run("k", job), c.run("k", job)]);
		await tick(30); // first run is now in flight
		const late = c.run("k", job);
		assert.deepEqual(await burst, [1, 1, 1]);
		assert.equal(await late, 2);
		assert.equal(runs, 2);
		assert.equal(c.size, 0);
	});
	it("keeps keys independent and propagates rejections", async () => {
		const c = new Coalescer(5);
		const [a, b] = await Promise.all([c.run("a", async () => "A"), c.run("b", async () => "B")]);
		assert.deepEqual([a, b], ["A", "B"]);
		await assert.rejects(
			c.run("x", async () => {
				throw new Error("boom");
			}),
			/boom/,
		);
	});
});

// -- end to end against the real tsc --------------------------------------------------

const tsc = resolveBinary("tsc", {
	platform: process.platform,
	localDirs: [REPO],
	env: process.env,
	isFile: (p) => {
		try {
			return statSync(p).isFile();
		} catch {
			return false;
		}
	},
	readFile: (p) => readFileSync(p, "utf8"),
	nodePath: process.execPath,
});

describe("extension end to end (real tsc)", { skip: tsc ? false : "tsc not installed" }, () => {
	let dir: string;
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi diag ")); // a space in the path, on purpose
		await mkdir(join(dir, "src"));
		await writeFile(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*.ts"] }));
		await writeFile(join(dir, "src", "ok.ts"), "export const n: number = 1;\n");
		await writeFile(join(dir, "src", "bad.ts"), "export const s: string = 42;\nexport const t = undefinedName;\n");
	});
	after(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	interface Handlers {
		tool_result?: (event: any, ctx: any) => Promise<any>;
		session_start?: (event: any, ctx: any) => Promise<void>;
	}

	function fakePi() {
		const handlers: Handlers = {};
		const commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }> = {};
		const pi = {
			on: (name: keyof Handlers, h: any) => {
				handlers[name] = h;
			},
			registerCommand: (name: string, opts: any) => {
				commands[name] = opts;
			},
			exec: (command: string, args: string[], options: { cwd?: string; timeout?: number }) =>
				new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>((done) => {
					execFile(command, args, { cwd: options.cwd, timeout: options.timeout, windowsHide: true }, (err, stdout, stderr) => {
						const code = err && typeof (err as any).code === "number" ? (err as any).code : err ? 1 : 0;
						done({ stdout: String(stdout), stderr: String(stderr), code, killed: !!(err as any)?.killed });
					});
				}),
		};
		return { pi, handlers, commands };
	}

	function fakeCtx(cwd: string) {
		const notices: string[] = [];
		const statuses: (string | undefined)[] = [];
		return {
			notices,
			statuses,
			ctx: {
				cwd,
				hasUI: true,
				ui: {
					notify: (m: string) => notices.push(m),
					setStatus: (_k: string, t: string | undefined) => statuses.push(t),
					theme: { fg: (_c: string, t: string) => t },
				},
			},
		};
	}

	it("appends the tsc line for a broken file and nothing for a clean one, keeping structuredContent", async () => {
		const { pi, handlers } = fakePi();
		// Run from the repo so the extension finds the repo's tsc (the temp project has no typescript install).
		diagnostics(pi as any);
		const { ctx, statuses } = fakeCtx(REPO);
		await handlers.session_start!({}, ctx);
		const badPath = join(dir, "src", "bad.ts");
		const event = {
			type: "tool_result",
			toolName: "write",
			toolCallId: "1",
			input: { path: badPath, content: "" },
			content: [{ type: "text", text: `Successfully wrote ${badPath}` }],
			structuredContent: { ok: true },
			isError: false,
		};
		const result = await handlers.tool_result!(event, ctx);
		assert.ok(result, "expected the handler to return modified content");
		assert.deepEqual(result.structuredContent, { ok: true });
		assert.equal(result.content.length, 2);
		assert.equal(result.content[0].text, event.content[0]!.text);
		const text: string = result.content[1].text;
		assert.match(text, /^\nDiagnostics \(tsc\): 2 errors\n/);
		assert.match(text, /src\/bad\.ts:1:14 TS2322 Type 'number' is not assignable to type 'string'\./);
		assert.match(text, /src\/bad\.ts:2:18 TS2552 Cannot find name 'undefinedName'\./);
		assert.equal(result.isError, undefined);
		assert.equal(statuses.at(-1), "diag: tsc 2 errors");

		const okPath = join(dir, "src", "ok.ts");
		const clean = await handlers.tool_result!({ ...event, input: { path: okPath }, content: [{ type: "text", text: "ok" }] }, ctx);
		assert.equal(clean, undefined);
		assert.equal(statuses.at(-1), "diag: tsc ok");
	});

	it("ignores errored results, other tools, unknown extensions, and respects /diagnostics off", async () => {
		const { pi, handlers, commands } = fakePi();
		diagnostics(pi as any);
		const { ctx, notices } = fakeCtx(REPO);
		await handlers.session_start!({}, ctx);
		const base = { type: "tool_result", toolCallId: "1", content: [{ type: "text", text: "x" }], isError: false };
		const badPath = join(dir, "src", "bad.ts");
		assert.equal(await handlers.tool_result!({ ...base, toolName: "edit", input: { path: badPath }, isError: true }, ctx), undefined);
		assert.equal(await handlers.tool_result!({ ...base, toolName: "bash", input: { command: "ls" } }, ctx), undefined);
		assert.equal(await handlers.tool_result!({ ...base, toolName: "write", input: { path: join(dir, "README.md") } }, ctx), undefined);
		await commands.diagnostics!.handler("off", ctx);
		assert.equal(await handlers.tool_result!({ ...base, toolName: "edit", input: { path: badPath } }, ctx), undefined);
		await commands.diagnostics!.handler("on", ctx);
		await commands.diagnostics!.handler(`run ${badPath}`, ctx);
		assert.match(notices.at(-1) ?? "", /Diagnostics \(tsc\): 2 errors/);
		await commands.diagnostics!.handler("status", ctx);
		assert.match(notices.at(-1) ?? "", /Diagnostics: on[\s\S]*Last run: diag: tsc 2 errors/);
	});

	it("reports a missing binary once and skips afterwards", async () => {
		const { pi, handlers } = fakePi();
		diagnostics(pi as any);
		const { ctx, notices } = fakeCtx(REPO);
		const prev = process.env.PI_CODING_AGENT_DIR;
		const cfgDir = await mkdtemp(join(tmpdir(), "pi-diag-cfg-"));
		process.env.PI_CODING_AGENT_DIR = cfgDir;
		try {
			await writeFile(join(cfgDir, "diagnostics.json"), JSON.stringify({ checkers: { ".zz": { command: "definitely-not-a-binary-xyz {file}" } } }));
			await handlers.session_start!({}, ctx);
		} finally {
			process.env.PI_CODING_AGENT_DIR = prev;
			await rm(cfgDir, { recursive: true, force: true });
		}
		const event = { type: "tool_result", toolName: "write", toolCallId: "1", input: { path: join(dir, "a.zz") }, content: [], isError: false };
		assert.equal(await handlers.tool_result!(event, ctx), undefined);
		assert.equal(await handlers.tool_result!(event, ctx), undefined);
		assert.equal(notices.filter((n) => n.includes("definitely-not-a-binary-xyz")).length, 1);
	});

	it("tells the user when the config file is broken and keeps defaults", async () => {
		const { pi, handlers } = fakePi();
		diagnostics(pi as any);
		const { ctx, notices } = fakeCtx(REPO);
		const prev = process.env.PI_CODING_AGENT_DIR;
		const cfgDir = await mkdtemp(join(tmpdir(), "pi-diag-cfg-"));
		process.env.PI_CODING_AGENT_DIR = cfgDir;
		try {
			await writeFile(join(cfgDir, "diagnostics.json"), "{ not json");
			await handlers.session_start!({}, ctx);
		} finally {
			process.env.PI_CODING_AGENT_DIR = prev;
			await rm(cfgDir, { recursive: true, force: true });
		}
		assert.match(notices[0] ?? "", /not valid JSON.*using defaults/);
		assert.ok(existsSync(join(REPO, "tsconfig.json")));
	});
});
