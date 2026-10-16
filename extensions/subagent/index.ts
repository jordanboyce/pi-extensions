/**
 * pi-subagent
 *
 * A model-callable `subagent` tool: runs a delegated task in a child pi session (a separate
 * process with its own context window, like the shipped subagent example) and returns its final
 * report. By default the child works in a fresh git worktree on its own branch, so parallel
 * children never touch the caller's files; `isolation: "shared"` runs it in place.
 *
 * Config (optional): ~/.pi/agent/subagent.json  -  see core.ts SubagentConfig.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	applyEvent,
	type ChildState,
	formatResult,
	JsonlParser,
	newChildState,
	normalizeConfig,
	parentExtensionArgs,
	progressText,
	randomSuffix,
	type ResolvedConfig,
	resolveConfig,
	type RunResult,
	Semaphore,
	sessionIdFor,
	statusDiff,
	truncate,
	worktreeName,
} from "./core.ts";
import {
	collectChanges,
	collectSharedChanges,
	createWorktree,
	ensureExcluded,
	excludePattern,
	type Git,
	GitError,
	removeWorktree,
	repoInfo,
	snapshotShared,
	worktreePath,
} from "./worktree.ts";

const STATUS_KEY = "subagent";
const DEPTH_ENV = "PI_SUBAGENT_DEPTH";

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "subagent.json");
}

/** A missing file means defaults; a broken one is reported (and defaults are used) rather than silently ignored. */
async function loadConfig(): Promise<{ config: ResolvedConfig; error?: string }> {
	let text: string;
	try {
		text = await readFile(configPath(), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: resolveConfig({}) };
		return { config: resolveConfig({}), error: `could not read ${configPath()}: ${(e as Error).message}` };
	}
	try {
		const r = normalizeConfig(JSON.parse(text));
		return r.error ? { config: resolveConfig({}), error: `${configPath()}: ${r.error}` } : { config: resolveConfig(r.config) };
	} catch (e) {
		return { config: resolveConfig({}), error: `${configPath()} is not valid JSON: ${(e as Error).message}` };
	}
}

/**
 * How to start a child pi. Inside pi, `process.argv[1]` is pi's cli script and `process.execPath`
 * the runtime that loaded it, so the child runs the very same pi (same approach as the shipped
 * subagent example). A configured `piPath` wins; a bare `pi` on PATH is the last resort.
 */
function piInvocation(piPath: string | undefined): { command: string; prefix: string[] } {
	if (piPath) {
		return /\.(c|m)?(j|t)s$/i.test(piPath) ? { command: process.execPath, prefix: [piPath] } : { command: piPath, prefix: [] };
	}
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && existsSync(script)) return { command: process.execPath, prefix: [script] };
	const runtime = basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(runtime)) return { command: process.execPath, prefix: [] };
	return { command: process.platform === "win32" ? "pi.cmd" : "pi", prefix: [] };
}

function killTree(proc: ChildProcess): void {
	if (proc.exitCode !== null || proc.pid === undefined) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => proc.kill());
		return;
	}
	proc.kill("SIGTERM");
	setTimeout(() => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	}, 5000).unref();
}

function childSystemPrompt(cwd: string, branch: string | undefined): string {
	const lines = [
		"You are a subagent: another pi session delegated one task to you and is waiting for your result.",
		"Nobody can answer questions here. If something is ambiguous, choose the most reasonable interpretation, say which, and continue; if the task is impossible, say why.",
		`Work only inside ${cwd}.`,
	];
	if (branch) {
		lines.push(
			`You are in a dedicated git worktree on branch ${branch}. Commit your changes there with a clear message when done (never push, never switch branches), unless the task says otherwise.`,
		);
	}
	lines.push(
		"Finish with a concise report for the caller: what you did, the files you changed, how you verified it, and anything they must know (decisions you made, things left undone). The report is all they will see.",
	);
	return lines.join("\n");
}

const Params = Type.Object({
	task: Type.String({
		description:
			"The complete brief: goal, relevant files or areas, constraints, and what done looks like. The child starts with no other context.",
	}),
	isolation: Type.Optional(
		StringEnum(["worktree", "shared"] as const, {
			description:
				'"worktree" (default): a fresh git worktree on a new branch, so the child cannot disturb the caller\'s files; it returns the branch. "shared": run in place in the working directory (for read-only or non-git work).',
			default: "worktree",
		}),
	),
	model: Type.Optional(Type.String({ description: "Model pattern for the child (as for pi --model). Default: the caller's model." })),
	cwd: Type.Optional(Type.String({ description: "Directory to run in (or to create the worktree from). Default: the caller's working directory." })),
});

export default async function subagent(pi: ExtensionAPI) {
	const depth = Math.max(0, Number.parseInt(process.env[DEPTH_ENV] ?? "0", 10) || 0);
	const loaded = await loadConfig();
	const config = loaded.config;

	pi.on("session_start", (_event, ctx) => {
		if (loaded.error) ctx.ui.notify(`subagent: ${loaded.error} (using defaults)`, "warning");
	});

	// A child at the depth limit does not get the tool at all, so it cannot fan out further.
	if (config.enabled === false || depth >= config.maxDepth) return;

	const semaphore = new Semaphore(config.maxConcurrent);
	const invocation = piInvocation(config.piPath);
	let active = 0;

	function git(opts: { signal?: AbortSignal }): Git {
		return async (args, cwd) => {
			const r = await pi.exec("git", ["--no-pager", "-c", "core.quotepath=false", ...args], { cwd, timeout: 60000, signal: opts.signal });
			return { stdout: r.stdout, stderr: r.stderr, code: r.code };
		};
	}

	pi.registerTool<typeof Params, RunResult | undefined>({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate one independent, well-specified task to a child pi session with its own context window, and get back its final report, the files it changed and (in worktree mode) the branch holding the work.",
			"Good for: self-contained pieces that can run while you continue (several calls run in parallel), broad searches whose details you do not need, and work that would flood your context.",
			"Not for: anything that needs the user's answer, approval or taste; small edits you can make directly; work that depends on files you are editing right now.",
			"The child sees nothing from this conversation: put the goal, the relevant files, constraints and what done looks like in `task`.",
			`Results are capped at ${config.maxOutputChars} characters; the child's session file is returned so the user can resume it.`,
		].join(" "),
		promptSnippet: "subagent: delegate an independent, well-specified task to a child pi session (worktree by default)",
		promptGuidelines: [
			"Use subagent only for independent, well-specified pieces whose brief you can write completely; never for work that needs the user's answers, and never for a quick edit you can make yourself.",
			"After a worktree subagent returns, integrate its branch deliberately (merge, cherry-pick or review the diff) rather than redoing the work; report the branch to the user.",
		],
		parameters: Params,
		executionMode: "parallel",

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const task = params.task.trim();
			if (!task) return fail("subagent: `task` is empty.");
			const isolation = params.isolation ?? "worktree";
			const startCwd = params.cwd ? (isAbsolute(params.cwd) ? params.cwd : resolve(ctx.cwd, params.cwd)) : ctx.cwd;
			if (!existsSync(startCwd) || !statSync(startCwd).isDirectory()) return fail(`subagent: cwd does not exist: ${startCwd}`);

			const update = (text: string, details?: RunResult) => onUpdate?.({ content: [{ type: "text", text }], details });
			const setStatus = () => {
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, active > 0 ? ctx.ui.theme.fg("dim", `subagents: ${active}${semaphore.waiting ? ` (+${semaphore.waiting} waiting)` : ""}`) : undefined);
			};

			if (semaphore.running >= semaphore.limit) update(`Waiting for a subagent slot (${semaphore.running} running, limit ${semaphore.limit})...`);
			let release: () => void;
			try {
				release = await semaphore.acquire(signal);
			} catch {
				return fail("subagent: aborted while waiting for a slot.");
			}
			active++;
			setStatus();

			const run = git({ signal });
			const state = newChildState();
			const result: RunResult = { isolation, cwd: startCwd, state, exitCode: -1, stderr: "", status: "completed" };
			let base: string | undefined;
			let sharedBefore: Awaited<ReturnType<typeof snapshotShared>>;
			let worktreeRoot: string | undefined;
			let pending: { root: string; path: string; branch: string } | undefined;

			try {
				// -- prepare the directory the child runs in
				if (isolation === "worktree") {
					const info = await repoInfo(run, startCwd);
					if (!info) return fail(`subagent: ${startCwd} is not inside a git repository; use isolation: "shared" or pass cwd.`);
					const names = worktreeName(task, randomSuffix(), config.branchPrefix);
					const path = worktreePath(info.root, config.worktreeDir, names.dirName);
					const pattern = excludePattern(info.root, config.worktreeDir);
					if (pattern) await ensureExcluded(info.commonDir, pattern).catch(() => undefined);
					pending = { root: info.root, path, branch: names.branch };
					await createWorktree(run, { root: info.root, path, branch: names.branch, base: info.head });
					pending = undefined;
					worktreeRoot = info.root;
					base = info.head;
					result.cwd = path;
					result.worktree = path;
					result.branch = names.branch;
					result.base = info.head;
				} else {
					sharedBefore = await snapshotShared(run, startCwd);
				}

				// -- run the child
				const sessionId = sessionIdFor(worktreeName(task, randomSuffix()).dirName);
				result.sessionId = sessionId;
				const label = result.branch ?? `shared: ${basename(result.cwd)}`;
				const args = [...invocation.prefix, "--mode", "json", "--session-id", sessionId, "-n", `subagent: ${truncate(task.split(/\r?\n/)[0] ?? task, 60)}`];
				const model = params.model ?? config.model;
				if (model) args.push("--model", model);
				else if (ctx.model) {
					args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
					if (ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
				}
				if (config.tools?.length) args.push("--tools", config.tools.join(","));
				if (config.inheritExtensions) args.push(...parentExtensionArgs(process.argv, process.cwd()));
				if (config.extraArgs?.length) args.push(...config.extraArgs);
				args.push("--append-system-prompt", childSystemPrompt(result.cwd, result.branch));
				args.push(task.startsWith("-") ? `Task: ${task}` : task);

				update(progressText(label, state, config.maxOutputChars), result);
				await new Promise<void>((done) => {
					let proc: ChildProcess;
					try {
						proc = spawn(invocation.command, args, {
							cwd: result.cwd,
							shell: false,
							stdio: ["ignore", "pipe", "pipe"],
							windowsHide: true,
							env: { ...process.env, [DEPTH_ENV]: String(depth + 1), PI_SUBAGENT_PARENT_SESSION: ctx.sessionManager.getSessionId() },
						});
					} catch (e) {
						result.status = "failed";
						result.failure = `could not start ${invocation.command}: ${(e as Error).message}`;
						return done();
					}
					const parser = new JsonlParser();
					let lastUpdate = 0;
					const onEvents = (events: unknown[]) => {
						for (const ev of events) applyEvent(state, ev);
						const now = Date.now();
						if (events.length && now - lastUpdate > 150) {
							lastUpdate = now;
							update(progressText(label, state, config.maxOutputChars), result);
						}
					};
					proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => onEvents(parser.feed(chunk)));
					proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
						if (result.stderr.length < 20000) result.stderr += chunk;
					});
					const stop = (status: RunResult["status"]) => {
						if (result.status === "completed") result.status = status;
						killTree(proc);
					};
					const onAbort = () => stop("aborted");
					if (signal?.aborted) onAbort();
					else signal?.addEventListener("abort", onAbort, { once: true });
					const timer = config.timeoutMinutes > 0 ? setTimeout(() => stop("timeout"), config.timeoutMinutes * 60000) : undefined;
					proc.on("error", (e) => {
						result.status = "failed";
						result.failure = `could not start ${invocation.command}: ${e.message}`;
					});
					proc.on("close", (code) => {
						onEvents(parser.flush());
						if (timer) clearTimeout(timer);
						signal?.removeEventListener("abort", onAbort);
						result.exitCode = code ?? -1;
						done();
					});
				});

				if (result.status === "completed") {
					if (result.exitCode !== 0) {
						result.status = "failed";
						result.failure = `child exited with code ${result.exitCode}`;
					} else if (state.stopReason === "error") {
						result.status = "failed";
						result.failure = state.errorMessage ?? "the model returned an error";
					} else if (state.stopReason === "aborted") {
						result.status = "aborted";
					}
				}

				// -- collect what changed, tidy up, locate the session
				try {
					if (isolation === "worktree" && base) {
						result.changes = await collectChanges(run, result.cwd, base);
						if (config.removeCleanWorktree && worktreeRoot && result.worktree && result.branch && !result.changes.files.length && !result.changes.commits.length) {
							const err = await removeWorktree(git({}), { root: worktreeRoot, path: result.worktree, branch: result.branch });
							if (!err) result.worktreeRemoved = true;
						}
					} else if (sharedBefore) {
						result.changes = await collectSharedChanges(run, result.cwd, sharedBefore, statusDiff);
					}
				} catch (e) {
					result.stderr += `\n[subagent: could not collect changes: ${(e as Error).message}]`;
				}
				try {
					result.sessionFile = SessionManager.findById(result.cwd, sessionId);
				} catch {
					/* non-default session dir: the id is still reported */
				}

				const text = formatResult(result, config.maxOutputChars);
				return { content: [{ type: "text", text }], details: result, isError: result.status !== "completed" };
			} catch (e) {
				const message = e instanceof GitError ? `git: ${e.message}` : (e as Error).message;
				// `git worktree add -b` can create the branch and still fail (long paths on Windows): leave nothing behind.
				if (pending) await removeWorktree(git({}), pending).catch(() => undefined);
				result.status = "failed";
				result.failure = message;
				return fail(`subagent: ${message}`, result);
			} finally {
				active--;
				release();
				setStatus();
			}
		},
	});

	function fail(text: string, details?: RunResult): AgentToolResult<RunResult | undefined> {
		return { content: [{ type: "text", text }], details, isError: true };
	}
}

export type { ChildState };
