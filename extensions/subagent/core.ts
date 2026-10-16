/**
 * Pure logic for pi-subagent: config validation, worktree/branch naming, the child's JSONL
 * event stream, progress and result formatting, argv forwarding and a small semaphore.
 * No pi imports, so it runs under plain `node --test`.
 */

import { isAbsolute, resolve } from "node:path";

export interface SubagentConfig {
	enabled?: boolean;
	/** Children running at once; further calls wait for a slot. Default 3. */
	maxConcurrent?: number;
	/** Nesting depth at which the tool is no longer offered. Default 1: children cannot spawn children. */
	maxDepth?: number;
	/** Cap on the text returned to the calling model. Default 16000 characters. */
	maxOutputChars?: number;
	/** Where worktrees go: relative to the repository root, or absolute. Default ".pi/worktrees". */
	worktreeDir?: string;
	/** Branch prefix for worktree runs. Default "subagent/". */
	branchPrefix?: string;
	/** Forward the parent's `-e/--extension` and `--no-extensions` flags to the child. Default true. */
	inheritExtensions?: boolean;
	/** Remove the worktree and branch again when the child changed nothing. Default true. */
	removeCleanWorktree?: boolean;
	/** Default model pattern for children. Default: the parent's model. */
	model?: string;
	/** Child `--tools` list, e.g. ["read", "grep", "find", "ls"] for read-only children. */
	tools?: string[];
	/** Extra CLI arguments appended to every child invocation, e.g. ["--no-mcp"]. */
	extraArgs?: string[];
	/** Kill a child that runs longer than this. Default 0 (no limit). */
	timeoutMinutes?: number;
	/** Explicit path to pi's cli.js (or a pi executable) when auto-detection fails. */
	piPath?: string;
}

export const DEFAULTS = {
	maxConcurrent: 3,
	maxDepth: 1,
	maxOutputChars: 16000,
	worktreeDir: ".pi/worktrees",
	branchPrefix: "subagent/",
	inheritExtensions: true,
	removeCleanWorktree: true,
	timeoutMinutes: 0,
} as const;

export type ResolvedConfig = Required<Pick<SubagentConfig, keyof typeof DEFAULTS>> & SubagentConfig;

export function resolveConfig(config: SubagentConfig): ResolvedConfig {
	return { ...DEFAULTS, ...Object.fromEntries(Object.entries(config).filter(([, v]) => v !== undefined)) } as ResolvedConfig;
}

/** Coerces a parsed config file into a usable config, reporting the first problem. */
export function normalizeConfig(raw: unknown): { config: SubagentConfig; error?: string } {
	if (raw === undefined || raw === null) return { config: {} };
	if (typeof raw !== "object" || Array.isArray(raw)) return { config: {}, error: "config must be a JSON object" };
	const r = raw as Record<string, unknown>;
	const config: SubagentConfig = {};
	for (const key of ["enabled", "inheritExtensions", "removeCleanWorktree"] as const) {
		const v = r[key];
		if (v === undefined) continue;
		if (typeof v !== "boolean") return { config: {}, error: `"${key}" must be true or false` };
		config[key] = v;
	}
	for (const key of ["maxConcurrent", "maxDepth", "maxOutputChars", "timeoutMinutes"] as const) {
		const v = r[key];
		if (v === undefined) continue;
		const n = typeof v === "string" && v.trim() ? Number(v) : v;
		if (typeof n !== "number" || !Number.isInteger(n) || n < 0) return { config: {}, error: `"${key}" must be a non-negative integer` };
		config[key] = n;
	}
	if (config.maxConcurrent === 0) return { config: {}, error: '"maxConcurrent" must be at least 1' };
	if (config.maxDepth === 0) return { config: {}, error: '"maxDepth" must be at least 1' };
	if (config.maxOutputChars !== undefined && config.maxOutputChars < 1000) return { config: {}, error: '"maxOutputChars" must be at least 1000' };
	for (const key of ["worktreeDir", "branchPrefix", "model", "piPath"] as const) {
		const v = r[key];
		if (v === undefined) continue;
		if (typeof v !== "string") return { config: {}, error: `"${key}" must be a string` };
		config[key] = v;
	}
	if (config.worktreeDir !== undefined && !config.worktreeDir.trim()) return { config: {}, error: '"worktreeDir" must not be empty' };
	if (config.branchPrefix !== undefined && !isValidRefPrefix(config.branchPrefix)) {
		return { config: {}, error: '"branchPrefix" must be a valid branch name prefix (no spaces, "..", "~", "^", ":", "?", "*", "[" or "\\")' };
	}
	for (const key of ["tools", "extraArgs"] as const) {
		const v = r[key];
		if (v === undefined) continue;
		if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) return { config: {}, error: `"${key}" must be an array of non-empty strings` };
		config[key] = v as string[];
	}
	return { config };
}

export function isValidRefPrefix(prefix: string): boolean {
	if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(prefix)) return false;
	if (prefix.includes("..") || prefix.includes("@{") || prefix.includes("//")) return false;
	if (prefix.startsWith("/") || prefix.startsWith("-")) return false;
	return true;
}

// ---------------------------------------------------------------- naming

/** Lower-case ASCII slug of a task, at most `max` characters, never empty. */
export function slugify(task: string, max = 32): string {
	const s = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return s || "task";
}

export interface WorktreeName {
	/** Directory name under the worktree dir. */
	dirName: string;
	/** Branch name, including the prefix. */
	branch: string;
}

/** Names for a worktree run. `suffix` keeps parallel runs of similar tasks apart (see {@link randomSuffix}). */
export function worktreeName(task: string, suffix: string, branchPrefix: string = DEFAULTS.branchPrefix): WorktreeName {
	const dirName = `${slugify(task)}-${suffix}`;
	return { dirName, branch: `${branchPrefix}${dirName}` };
}

export function randomSuffix(random: () => number = Math.random): string {
	return Math.floor(random() * 0x1000000)
		.toString(16)
		.padStart(6, "0");
}

/** A session id pi accepts (letters, digits, ".", "_", "-", alphanumeric at both ends). */
export function sessionIdFor(dirName: string, now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
	return `subagent-${stamp}-${dirName}`.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

// ---------------------------------------------------------------- JSONL event stream

/** Splits a byte stream into JSON records on LF only (pi's framing); CR before LF is tolerated. */
export class JsonlParser {
	private buffer = "";

	feed(chunk: string): unknown[] {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return parseLines(lines);
	}

	flush(): unknown[] {
		const rest = this.buffer;
		this.buffer = "";
		return rest.trim() ? parseLines([rest]) : [];
	}
}

function parseLines(lines: string[]): unknown[] {
	const out: unknown[] = [];
	for (let line of lines) {
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			/* diagnostics or partial output: not a record */
		}
	}
	return out;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface ChildState {
	sessionId?: string;
	cwd?: string;
	/** Text of the last completed assistant message. */
	lastText: string;
	/** Text of the assistant message currently streaming. */
	partialText: string;
	toolCalls: number;
	lastTool?: string;
	usage: Usage;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	settled: boolean;
}

export function newChildState(): ChildState {
	return { lastText: "", partialText: "", toolCalls: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }, settled: false };
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Folds one pi JSON-mode event into the state. Unknown or malformed events are ignored. */
export function applyEvent(state: ChildState, event: unknown): void {
	const e = rec(event);
	if (!e) return;
	switch (e.type) {
		case "session":
			if (typeof e.id === "string") state.sessionId = e.id;
			if (typeof e.cwd === "string") state.cwd = e.cwd;
			return;
		case "message_update": {
			const ev = rec(e.assistantMessageEvent);
			if (ev?.type === "text_delta" && typeof ev.delta === "string") state.partialText += ev.delta;
			return;
		}
		case "message_end": {
			const msg = rec(e.message);
			if (msg?.role !== "assistant") return;
			state.partialText = "";
			const text = assistantText(msg);
			if (text) state.lastText = text;
			state.usage.turns++;
			const u = rec(msg.usage);
			if (u) {
				state.usage.input += num(u.input);
				state.usage.output += num(u.output);
				state.usage.cacheRead += num(u.cacheRead);
				state.usage.cacheWrite += num(u.cacheWrite);
				state.usage.cost += num(rec(u.cost)?.total);
				state.usage.contextTokens = num(u.totalTokens) || state.usage.contextTokens;
			}
			if (typeof msg.model === "string" && !state.model) state.model = msg.model;
			if (typeof msg.stopReason === "string") state.stopReason = msg.stopReason;
			if (typeof msg.errorMessage === "string") state.errorMessage = msg.errorMessage;
			return;
		}
		case "tool_execution_start":
			state.toolCalls++;
			if (typeof e.toolName === "string") state.lastTool = describeToolCall(e.toolName, rec(e.args) ?? {});
			return;
		case "agent_settled":
			state.settled = true;
			return;
	}
}

function assistantText(msg: Rec): string {
	const parts = Array.isArray(msg.content) ? msg.content : [];
	return parts
		.map((p) => rec(p))
		.filter((p): p is Rec => p?.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string)
		.join("\n")
		.trim();
}

/** One-line description of a tool call, mirroring pi's own transcript labels. */
export function describeToolCall(name: string, args: Rec): string {
	const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
	const short = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n)}...` : s);
	const file = str("file_path") ?? str("path") ?? "...";
	switch (name) {
		case "bash":
		case "powershell":
			return `$ ${short((str("command") ?? "...").replace(/\s+/g, " "))}`;
		case "read":
		case "write":
		case "edit":
		case "ls":
			return `${name} ${file}`;
		case "find":
			return `find ${str("pattern") ?? "*"} in ${str("path") ?? "."}`;
		case "grep":
			return `grep /${str("pattern") ?? ""}/ in ${str("path") ?? "."}`;
		default:
			return short(`${name} ${JSON.stringify(args)}`, 80);
	}
}

/** The text streamed to the parent while the child runs. */
export function progressText(label: string, state: ChildState, maxChars: number): string {
	const head = [`[${label}]`, `${state.toolCalls} tool call${state.toolCalls === 1 ? "" : "s"}`];
	if (state.lastTool) head.push(`last: ${state.lastTool}`);
	const text = (state.partialText || state.lastText).trim();
	return truncate(`${head.join(" - ")}\n\n${text || "(starting...)"}`, maxChars);
}

// ---------------------------------------------------------------- results

export interface Changes {
	/** `git log --oneline base..HEAD` in the run directory. */
	commits: string[];
	/** Paths changed against the base (tracked and untracked). */
	files: string[];
	/** `git diff --stat` against the base, plus untracked files. */
	diffStat: string;
	/** Uncommitted changes remain. */
	dirty: boolean;
}

export interface RunResult {
	isolation: "worktree" | "shared";
	cwd: string;
	branch?: string;
	worktree?: string;
	/** The worktree was removed because nothing changed. */
	worktreeRemoved?: boolean;
	base?: string;
	changes?: Changes;
	sessionId?: string;
	sessionFile?: string;
	state: ChildState;
	exitCode: number;
	stderr: string;
	status: "completed" | "failed" | "aborted" | "timeout";
	failure?: string;
}

export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsage(u: Usage, model?: string): string {
	const parts: string[] = [];
	if (u.turns) parts.push(`${u.turns} turn${u.turns === 1 ? "" : "s"}`);
	if (u.input) parts.push(`in ${formatTokens(u.input)}`);
	if (u.output) parts.push(`out ${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`cache ${formatTokens(u.cacheRead)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
	if (u.contextTokens) parts.push(`ctx ${formatTokens(u.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(", ");
}

export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	const note = (n: number) => `\n[truncated: ${n} characters omitted]`;
	const keep = Math.max(0, max - note(text.length).length);
	return text.slice(0, keep) + note(text.length - keep);
}

function list(items: string[], max: number, indent = "  "): string {
	const shown = items.slice(0, max).map((i) => `${indent}${i}`);
	if (items.length > max) shown.push(`${indent}... and ${items.length - max} more`);
	return shown.join("\n");
}

/** The tool result text: summary first, then what the caller needs to act on the work. */
export function formatResult(r: RunResult, maxChars: number): string {
	const meta: string[] = [];
	const statusLine =
		r.status === "completed" ? "completed" : r.status === "aborted" ? "aborted by the caller" : r.status === "timeout" ? "killed: time limit reached" : `failed: ${r.failure ?? "unknown error"}`;
	meta.push(`Status: ${statusLine}`);
	if (r.isolation === "worktree") {
		meta.push(`Branch: ${r.branch}${r.base ? ` (from ${r.base.slice(0, 10)})` : ""}`);
		meta.push(r.worktreeRemoved ? `Worktree: removed (no changes) - was ${r.worktree}` : `Worktree: ${r.worktree}`);
	} else {
		meta.push(`Directory: ${r.cwd} (shared, no isolation)`);
	}
	const c = r.changes;
	if (c) {
		if (c.commits.length) meta.push(`Commits (${c.commits.length}):\n${list(c.commits, 10)}`);
		meta.push(c.files.length ? `Files changed (${c.files.length}):\n${list(c.files, 50)}` : "Files changed: none");
		const statLines = c.diffStat.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		if (statLines.length) meta.push(`Diff stat:\n${list(statLines, 30)}`);
		if (c.dirty && r.isolation === "worktree") meta.push("Uncommitted changes remain in the worktree; commit or cherry-pick from there.");
		if (c.dirty && r.isolation === "shared") meta.push("Changes are uncommitted in the shared directory.");
	}
	if (r.sessionFile) meta.push(`Session: ${r.sessionFile}\n  resume: pi --session "${r.sessionFile}"`);
	else if (r.sessionId) meta.push(`Session id: ${r.sessionId}\n  resume (from ${r.worktree ?? r.cwd}): pi --session ${r.sessionId}`);
	const usage = formatUsage(r.state.usage, r.state.model);
	if (usage) meta.push(`Usage: ${usage}`);
	const metaText = meta.join("\n");

	let summary = r.state.lastText.trim() || r.state.partialText.trim();
	if (!summary) {
		summary = r.status === "completed" ? "(the child produced no text)" : (r.failure ?? r.stderr.trim() ?? "").trim() || "(no output)";
	} else if (r.status === "failed" && r.stderr.trim()) {
		summary += `\n\nstderr:\n${r.stderr.trim()}`;
	}
	const budget = Math.max(500, maxChars - metaText.length - 20);
	return truncate(`${truncate(summary, budget)}\n\n---\n${metaText}`, maxChars);
}

// ---------------------------------------------------------------- argv forwarding

/**
 * The parent's explicit extension flags (`-e/--extension <path>`, `--no-extensions`), with paths
 * made absolute against `baseDir` so the child can load them from another working directory.
 */
export function parentExtensionArgs(argv: readonly string[], baseDir: string): string[] {
	const out: string[] = [];
	const addPath = (p: string) => {
		const value = p.startsWith("builtin:") || isAbsolute(p) ? p : resolve(baseDir, p);
		out.push("-e", value);
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] ?? "";
		if (a === "-e" || a === "--extension") {
			const next = argv[i + 1];
			if (next !== undefined) {
				addPath(next);
				i++;
			}
		} else if (a.startsWith("--extension=")) {
			addPath(a.slice("--extension=".length));
		} else if (a === "-ne" || a === "--no-extensions") {
			out.push("--no-extensions");
		}
	}
	return out;
}

// ---------------------------------------------------------------- shared-mode change detection

/** Path of one `git status --porcelain` line (the new name for renames). */
export function statusPath(line: string): string | undefined {
	if (line.length < 4) return undefined;
	const p = line.slice(3);
	const arrow = p.indexOf(" -> ");
	return (arrow >= 0 ? p.slice(arrow + 4) : p).replace(/^"|"$/g, "");
}

/** Paths whose working-tree status changed between two `git status --porcelain` snapshots. */
export function statusDiff(before: string, after: string): string[] {
	const split = (s: string) => new Set(s.split(/\r?\n/).filter((l) => l.trim()));
	const b = split(before);
	const a = split(after);
	const paths = new Set<string>();
	for (const line of a) if (!b.has(line)) paths.add(statusPath(line) ?? line);
	for (const line of b) if (!a.has(line)) paths.add(statusPath(line) ?? line);
	return [...paths].sort();
}

// ---------------------------------------------------------------- concurrency

/** Counting semaphore. `acquire` rejects when `signal` aborts while waiting. */
export class Semaphore {
	private queue: { grant: () => void; cancel: (err: Error) => void }[] = [];
	running = 0;
	readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	get waiting(): number {
		return this.queue.length;
	}

	acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("aborted while waiting for a subagent slot"));
		if (this.running < this.limit) {
			this.running++;
			return Promise.resolve(this.release());
		}
		return new Promise((res, rej) => {
			const entry = {
				grant: () => {
					signal?.removeEventListener("abort", onAbort);
					this.running++;
					res(this.release());
				},
				cancel: (err: Error) => rej(err),
			};
			const onAbort = () => {
				this.queue = this.queue.filter((q) => q !== entry);
				entry.cancel(new Error("aborted while waiting for a subagent slot"));
			};
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort, { once: true });
			this.queue.push(entry);
		});
	}

	private release(): () => void {
		let done = false;
		return () => {
			if (done) return;
			done = true;
			this.running--;
			this.queue.shift()?.grant();
		};
	}
}
