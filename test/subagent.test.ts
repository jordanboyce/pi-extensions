import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import {
	applyEvent,
	describeToolCall,
	formatResult,
	isValidRefPrefix,
	JsonlParser,
	newChildState,
	normalizeConfig,
	parentExtensionArgs,
	progressText,
	randomSuffix,
	resolveConfig,
	type RunResult,
	Semaphore,
	sessionIdFor,
	slugify,
	statusDiff,
	truncate,
	worktreeName,
} from "../extensions/subagent/core.ts";
import {
	collectChanges,
	collectSharedChanges,
	createWorktree,
	ensureExcluded,
	excludePattern,
	type Git,
	removeWorktree,
	repoInfo,
	snapshotShared,
	worktreePath,
} from "../extensions/subagent/worktree.ts";

const run = promisify(execFile);

describe("normalizeConfig", () => {
	it("accepts an empty or missing file and coerces numeric strings", () => {
		assert.deepEqual(normalizeConfig(undefined), { config: {} });
		assert.deepEqual(normalizeConfig({}), { config: {} });
		const r = normalizeConfig({ maxConcurrent: "2", maxOutputChars: 5000, tools: ["read", "grep"], branchPrefix: "agents/" });
		assert.equal(r.error, undefined);
		assert.deepEqual(r.config, { maxConcurrent: 2, maxOutputChars: 5000, tools: ["read", "grep"], branchPrefix: "agents/" });
	});
	it("rejects bad values with a named key", () => {
		assert.match(normalizeConfig([]).error!, /JSON object/);
		assert.match(normalizeConfig({ maxConcurrent: 0 }).error!, /maxConcurrent/);
		assert.match(normalizeConfig({ maxDepth: -1 }).error!, /maxDepth/);
		assert.match(normalizeConfig({ maxOutputChars: 10 }).error!, /at least 1000/);
		assert.match(normalizeConfig({ enabled: "yes" }).error!, /enabled/);
		assert.match(normalizeConfig({ tools: "read,grep" }).error!, /tools/);
		assert.match(normalizeConfig({ extraArgs: [""] }).error!, /extraArgs/);
		assert.match(normalizeConfig({ worktreeDir: "  " }).error!, /worktreeDir/);
		assert.match(normalizeConfig({ branchPrefix: "bad name/" }).error!, /branchPrefix/);
	});
	it("resolveConfig fills defaults without overriding explicit values", () => {
		const c = resolveConfig({ maxConcurrent: 1, enabled: true });
		assert.equal(c.maxConcurrent, 1);
		assert.equal(c.maxDepth, 1);
		assert.equal(c.worktreeDir, ".pi/worktrees");
		assert.equal(c.enabled, true);
	});
	it("isValidRefPrefix follows git's ref rules", () => {
		assert.equal(isValidRefPrefix("subagent/"), true);
		assert.equal(isValidRefPrefix("feat-"), true);
		for (const bad of ["a b/", "a..b/", "~x/", "/lead", "-dash", "a//b", "x@{1}", "q?"]) assert.equal(isValidRefPrefix(bad), false, bad);
	});
});

describe("naming", () => {
	it("slugify lower-cases, strips punctuation and caps length", () => {
		assert.equal(slugify("Add README section: Install!"), "add-readme-section-install");
		assert.equal(slugify("!!!"), "task");
		assert.equal(slugify("x".repeat(100)).length, 32);
		assert.equal(slugify("abc def ghi jkl mno pqr stu vwx yz", 20), "abc-def-ghi-jkl-mno");
	});
	it("worktreeName joins slug, suffix and prefix", () => {
		assert.deepEqual(worktreeName("Fix the login bug", "abc123"), { dirName: "fix-the-login-bug-abc123", branch: "subagent/fix-the-login-bug-abc123" });
		assert.equal(worktreeName("Fix", "0f0f0f", "agents/").branch, "agents/fix-0f0f0f");
	});
	it("randomSuffix is six hex characters", () => {
		assert.match(randomSuffix(), /^[0-9a-f]{6}$/);
		assert.equal(randomSuffix(() => 0), "000000");
		assert.equal(randomSuffix(() => 0.999999999), "ffffff");
	});
	it("sessionIdFor produces an id pi accepts", () => {
		const id = sessionIdFor("fix-the-login-bug-abc123", new Date("2026-10-16T12:34:56.789Z"));
		assert.equal(id, "subagent-20261016-123456-fix-the-login-bug-abc123");
		assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
	});
});

describe("JsonlParser", () => {
	it("splits on LF only, tolerates CRLF and partial chunks, skips non-JSON lines", () => {
		const p = new JsonlParser();
		assert.deepEqual(p.feed('{"a":1}\r\n{"b":'), [{ a: 1 }]);
		assert.deepEqual(p.feed('2}\nnot json\n{"c":"line\u2028sep"}\n'), [{ b: 2 }, { c: "line\u2028sep" }]);
		assert.deepEqual(p.feed('{"d":4}'), []);
		assert.deepEqual(p.flush(), [{ d: 4 }]);
		assert.deepEqual(p.flush(), []);
	});
});

describe("applyEvent / progressText", () => {
	it("tracks session, streamed text, usage, tool calls and settling", () => {
		const s = newChildState();
		applyEvent(s, { type: "session", version: 3, id: "sess-1", cwd: "/repo" });
		applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
		applyEvent(s, { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } });
		assert.equal(progressText("subagent/x", s, 1000), "[subagent/x] - 0 tool calls\n\nHello");
		applyEvent(s, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "npm   test" } });
		applyEvent(s, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Done." }],
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, totalTokens: 125, cost: { total: 0.01 } },
				model: "claude-x",
				stopReason: "stop",
			},
		});
		applyEvent(s, { type: "agent_settled", aborted: false });
		assert.equal(s.sessionId, "sess-1");
		assert.equal(s.partialText, "");
		assert.equal(s.lastText, "Done.");
		assert.equal(s.toolCalls, 1);
		assert.equal(s.lastTool, "$ npm test");
		assert.deepEqual(s.usage, { input: 100, output: 20, cacheRead: 5, cacheWrite: 0, cost: 0.01, contextTokens: 125, turns: 1 });
		assert.equal(s.model, "claude-x");
		assert.equal(s.settled, true);
		assert.equal(progressText("subagent/x", s, 1000), "[subagent/x] - 1 tool call - last: $ npm test\n\nDone.");
	});
	it("ignores malformed events and keeps error details", () => {
		const s = newChildState();
		applyEvent(s, null);
		applyEvent(s, "x");
		applyEvent(s, { type: "message_end", message: { role: "user", content: "hi" } });
		applyEvent(s, { type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" } });
		assert.equal(s.stopReason, "error");
		assert.equal(s.errorMessage, "rate limited");
		assert.equal(s.lastText, "");
	});
	it("describeToolCall mirrors pi's labels", () => {
		assert.equal(describeToolCall("read", { path: "src/a.ts" }), "read src/a.ts");
		assert.equal(describeToolCall("grep", { pattern: "foo", path: "src" }), "grep /foo/ in src");
		assert.equal(describeToolCall("find", { pattern: "*.ts" }), "find *.ts in .");
		assert.equal(describeToolCall("custom", { a: 1 }), 'custom {"a":1}');
		assert.equal(describeToolCall("bash", { command: "x".repeat(80) }).length, "$ ".length + 63);
	});
});

describe("truncate / formatResult", () => {
	it("truncate keeps the result within the cap and says how much was cut", () => {
		assert.equal(truncate("short", 100), "short");
		const t = truncate("y".repeat(1000), 200);
		assert.ok(t.length <= 200, String(t.length));
		assert.match(t, /\[truncated: \d+ characters omitted\]$/);
	});
	const base = (): RunResult => ({
		isolation: "worktree",
		cwd: "D:\\repo\\.pi\\worktrees\\fix-abc123",
		worktree: "D:\\repo\\.pi\\worktrees\\fix-abc123",
		branch: "subagent/fix-abc123",
		base: "0123456789abcdef",
		sessionId: "subagent-1",
		sessionFile: "C:\\Users\\me\\.pi\\agent\\sessions\\x\\s.jsonl",
		state: { ...newChildState(), lastText: "I fixed it.", usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.0123, contextTokens: 1500, turns: 3 }, model: "m" },
		changes: { commits: ["abc1234 fix: thing"], files: ["src/a.ts", "src/b.ts"], diffStat: " src/a.ts | 2 +-\n 1 file changed", dirty: false },
		exitCode: 0,
		stderr: "",
		status: "completed",
	});
	it("puts the summary first and the branch, files, session and usage after", () => {
		const text = formatResult(base(), 16000);
		assert.ok(text.startsWith("I fixed it.\n\n---\nStatus: completed\n"));
		assert.match(text, /Branch: subagent\/fix-abc123 \(from 0123456789\)/);
		assert.match(text, /Worktree: D:\\repo\\.pi\\worktrees\\fix-abc123/);
		assert.match(text, /Commits \(1\):\n {2}abc1234 fix: thing/);
		assert.match(text, /Files changed \(2\):\n {2}src\/a.ts\n {2}src\/b.ts/);
		assert.match(text, /Diff stat:\n {2}src\/a.ts \| 2 \+-\n {2}1 file changed/);
		assert.match(text, /Session: C:\\Users\\me\\.pi\\agent\\sessions\\x\\s.jsonl\n {2}resume: pi --session "C:/);
		assert.match(text, /Usage: 3 turns, in 1.2k, out 300, \$0.0123, ctx 1.5k, m/);
		assert.doesNotMatch(text, /Uncommitted/);
	});
	it("reports dirty worktrees, removed worktrees, shared mode and failures", () => {
		const dirty = base();
		dirty.changes!.dirty = true;
		assert.match(formatResult(dirty, 16000), /Uncommitted changes remain in the worktree/);
		const removed = base();
		removed.worktreeRemoved = true;
		removed.changes = { commits: [], files: [], diffStat: "", dirty: false };
		const rt = formatResult(removed, 16000);
		assert.match(rt, /Worktree: removed \(no changes\)/);
		assert.match(rt, /Files changed: none/);
		const shared = base();
		shared.isolation = "shared";
		shared.cwd = "/work/repo";
		assert.match(formatResult(shared, 16000), /Directory: \/work\/repo \(shared, no isolation\)/);
		const failed = base();
		failed.status = "failed";
		failed.failure = "child exited with code 1";
		failed.stderr = "boom";
		const ft = formatResult(failed, 16000);
		assert.match(ft, /Status: failed: child exited with code 1/);
		assert.match(ft, /stderr:\nboom/);
		const aborted = base();
		aborted.status = "aborted";
		aborted.state = { ...newChildState(), partialText: "half way" };
		assert.ok(formatResult(aborted, 16000).startsWith("half way\n\n---\nStatus: aborted by the caller"));
		const noFile = base();
		noFile.sessionFile = undefined;
		assert.match(formatResult(noFile, 16000), /Session id: subagent-1\n {2}resume \(from D:\\repo/);
	});
	it("respects the output cap, trimming the summary before the metadata", () => {
		const r = base();
		r.state.lastText = "z".repeat(50000);
		const text = formatResult(r, 2000);
		assert.ok(text.length <= 2000, String(text.length));
		assert.match(text, /Branch: subagent\/fix-abc123/);
		assert.match(text, /\[truncated: \d+ characters omitted\]/);
	});
});

describe("parentExtensionArgs", () => {
	it("forwards -e/--extension with absolute paths and --no-extensions", () => {
		const argv = ["node", "cli.js", "-e", "./extensions/subagent", "--extension", "/abs/x.ts", "--extension=builtin:mcp", "-ne", "--model", "sonnet", "-e"];
		const out = parentExtensionArgs(argv, "/base");
		assert.deepEqual(out, ["-e", resolve("/base", "extensions", "subagent"), "-e", "/abs/x.ts", "-e", "builtin:mcp", "--no-extensions"]);
	});
	it("returns nothing when the parent used only discovered extensions", () => {
		assert.deepEqual(parentExtensionArgs(["node", "cli.js", "--model", "x"], "/base"), []);
	});
});

describe("statusDiff", () => {
	it("reports paths whose status line changed in either direction, renames by new name", () => {
		const before = " M a.ts\n?? new.txt\n M committed.ts\n";
		const after = " M a.ts\n?? new.txt\nM  b.ts\nR  old.ts -> renamed.ts\n?? \"sp ace.txt\"\n";
		assert.deepEqual(statusDiff(before, after), ["b.ts", "committed.ts", "renamed.ts", "sp ace.txt"]);
		assert.deepEqual(statusDiff("", ""), []);
	});
});

describe("Semaphore", () => {
	it("limits concurrency, queues in order and honours abort while waiting", async () => {
		const s = new Semaphore(1);
		const r1 = await s.acquire();
		assert.equal(s.running, 1);
		let second = false;
		const p2 = s.acquire().then((rel) => {
			second = true;
			return rel;
		});
		const ac = new AbortController();
		const p3 = s.acquire(ac.signal);
		assert.equal(s.waiting, 2);
		ac.abort();
		await assert.rejects(p3, /aborted while waiting/);
		assert.equal(s.waiting, 1);
		assert.equal(second, false);
		r1();
		r1(); // double release is harmless
		const r2 = await p2;
		assert.equal(second, true);
		assert.equal(s.running, 1);
		r2();
		assert.equal(s.running, 0);
		await assert.rejects(s.acquire(AbortSignal.abort()), /aborted/);
	});
});

describe("worktree (real temp repo)", () => {
	let dir: string;
	let gitAvailable = true;
	const git: Git = async (args, cwd) => {
		try {
			const r = await run("git", args, { cwd, windowsHide: true });
			return { stdout: r.stdout, stderr: r.stderr, code: 0 };
		} catch (e) {
			const err = e as { stdout?: string; stderr?: string; code?: number };
			return { stdout: err.stdout ?? "", stderr: err.stderr ?? String(e), code: typeof err.code === "number" ? err.code : 1 };
		}
	};
	const sh = async (args: string[], cwd = dir) => {
		const r = await git(args, cwd);
		assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
		return r.stdout;
	};

	before(async () => {
		try {
			await run("git", ["--version"]);
		} catch {
			gitAvailable = false;
			return;
		}
		dir = await mkdtemp(join(tmpdir(), "pi-subagent-"));
		await sh(["init", "-q", "-b", "main"]);
		await sh(["config", "user.email", "t@example.com"]);
		await sh(["config", "user.name", "Test"]);
		await sh(["config", "commit.gpgsign", "false"]);
		await writeFile(join(dir, "a.txt"), "one\n");
		await sh(["add", "."]);
		await sh(["commit", "-q", "-m", "init"]);
	});
	after(async () => {
		if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
	});

	it("worktreePath and excludePattern handle relative and absolute dirs", () => {
		const root = ["D:", "repo"].join(sep);
		assert.equal(worktreePath(root, ".pi/worktrees", "x-1"), ["D:", "repo", ".pi", "worktrees", "x-1"].join(sep));
		assert.equal(worktreePath(root, join(sep, "tmp", "wt"), "x-1"), join(sep, "tmp", "wt", "x-1"));
		assert.equal(excludePattern(root, ".pi/worktrees"), "/.pi/worktrees/");
		assert.equal(excludePattern(root, join(sep, "tmp", "wt")), undefined);
	});

	it("creates a worktree on a new branch, sees changes, and removes it again", { skip: !gitAvailable && "git not installed" }, async () => {
		const info = await repoInfo(git, dir);
		assert.ok(info);
		assert.equal(info.branch, "main");
		assert.equal(info.root.toLowerCase(), (await sh(["rev-parse", "--show-toplevel"])).trim().replace(/\//g, sep).toLowerCase());
		assert.equal(await repoInfo(git, tmpdir()).catch(() => "threw"), undefined);

		await ensureExcluded(info.commonDir, "/.pi/worktrees/");
		await ensureExcluded(info.commonDir, "/.pi/worktrees/");
		const exclude = await readFile(join(info.commonDir, "info", "exclude"), "utf8");
		assert.equal(exclude.split("/.pi/worktrees/").length, 2, "pattern written exactly once");

		const path = worktreePath(info.root, ".pi/worktrees", "demo-abc123");
		await createWorktree(git, { root: info.root, path, branch: "subagent/demo-abc123", base: info.head });
		assert.equal((await sh(["rev-parse", "--abbrev-ref", "HEAD"], path)).trim(), "subagent/demo-abc123");
		assert.equal((await sh(["status", "--porcelain"])).trim(), "", "worktree dir is excluded in the main checkout");

		const clean = await collectChanges(git, path, info.head);
		assert.deepEqual(clean, { commits: [], files: [], diffStat: "", dirty: false });

		await writeFile(join(path, "a.txt"), "one\ntwo\n");
		await writeFile(join(path, "new.txt"), "hi\n");
		const dirty = await collectChanges(git, path, info.head);
		assert.deepEqual(dirty.files, ["a.txt", "new.txt"]);
		assert.equal(dirty.dirty, true);
		assert.match(dirty.diffStat, /a\.txt \| 1 \+/);
		assert.match(dirty.diffStat, /1 untracked file$/);

		await sh(["add", "."], path);
		await sh(["commit", "-q", "-m", "subagent: edit"], path);
		const committed = await collectChanges(git, path, info.head);
		assert.equal(committed.commits.length, 1);
		assert.match(committed.commits[0]!, /subagent: edit$/);
		assert.deepEqual(committed.files, ["a.txt", "new.txt"]);
		assert.equal(committed.dirty, false);

		// a second worktree from the same base does not collide
		const path2 = worktreePath(info.root, ".pi/worktrees", "demo-def456");
		await createWorktree(git, { root: info.root, path: path2, branch: "subagent/demo-def456", base: info.head });
		await assert.rejects(createWorktree(git, { root: info.root, path: path2, branch: "subagent/demo-def456", base: info.head }), /already/);

		assert.equal(await removeWorktree(git, { root: info.root, path: path2, branch: "subagent/demo-def456" }), undefined);
		assert.equal(await removeWorktree(git, { root: info.root, path, branch: "subagent/demo-abc123" }), undefined);
		assert.doesNotMatch(await sh(["branch", "--list", "subagent/*"]), /demo/);
		assert.doesNotMatch(await sh(["worktree", "list"]), /demo/);
	});

	it("shared mode reports only what changed during the run", { skip: !gitAvailable && "git not installed" }, async () => {
		await writeFile(join(dir, "preexisting.txt"), "x\n"); // untracked before the run: not the child's doing
		const before = await snapshotShared(git, dir);
		assert.ok(before?.head);
		await writeFile(join(dir, "a.txt"), "changed by child\n");
		await writeFile(join(dir, "child.txt"), "y\n");
		const changes = await collectSharedChanges(git, dir, before, statusDiff);
		assert.deepEqual(changes.files, ["a.txt", "child.txt"]);
		assert.equal(changes.dirty, true);
		assert.match(changes.diffStat, /a\.txt \| 2 \+-/);
		assert.deepEqual(changes.commits, []);

		await sh(["add", "a.txt", "child.txt"]);
		await sh(["commit", "-q", "-m", "child commit"]);
		const after = await collectSharedChanges(git, dir, before, statusDiff);
		assert.deepEqual(after.files, ["a.txt", "child.txt"]);
		assert.equal(after.commits.length, 1);
		assert.equal(after.dirty, false);
		assert.equal(await snapshotShared(git, tmpdir()), undefined);
	});
});
