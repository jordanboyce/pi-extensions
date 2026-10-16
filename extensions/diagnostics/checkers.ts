/**
 * Pure logic for pi-diagnostics: which checker runs for a file, how its command template becomes
 * an argv, how a checker binary is located without a shell, how tsc/pyright/generic output is
 * parsed and filtered, how the result block is rendered, config validation, and the per-command
 * coalescer. No pi imports, so it runs under plain `node --test`.
 */

import { posix, win32 } from "node:path";

export type Format = "tsc" | "pyright" | "generic";
export const FORMATS: readonly Format[] = ["tsc", "pyright", "generic"];

export interface Checker {
	/** Label in the result header and footer. Defaults to the command's binary name. */
	name?: string;
	/**
	 * Command template, split like a shell line (double or single quotes group words). The first
	 * word is the binary. Placeholders: {file} {dir} {root} {marker} {relfile} {cwd}.
	 */
	command: string;
	/** File name (e.g. "tsconfig.json") whose nearest ancestor directory becomes {root}. Without it {root} is the session cwd. */
	marker?: string;
	/** Template used instead of `command` when `marker` is not found above the file. */
	fallback?: string;
	/** Output format to parse. Default "generic" (`file:line:col: message`). */
	format?: Format;
	/** Keep only diagnostics about the edited file (and file-less ones). Default true. */
	filter?: boolean;
	/** Overrides the global timeout for this checker. */
	timeoutMs?: number;
}

export interface DiagnosticsConfig {
	enabled: boolean;
	timeoutMs: number;
	debounceMs: number;
	maxLines: number;
	/** Lower-case extension with dot -> ordered candidates; the first whose binary exists runs. */
	checkers: Record<string, Checker[]>;
}

const TSC: Checker = {
	name: "tsc",
	command: "tsc -p {marker} --noEmit --pretty false",
	marker: "tsconfig.json",
	fallback: "tsc --noEmit --pretty false {file}",
	format: "tsc",
};

export const DEFAULT_CHECKERS: Readonly<Record<string, Checker[]>> = {
	".ts": [TSC],
	".tsx": [TSC],
	".mts": [TSC],
	".cts": [TSC],
	".py": [
		{ name: "pyright", command: "pyright {file}", marker: "pyproject.toml", format: "pyright" },
		{ name: "pyflakes", command: "python -m pyflakes {file}", format: "generic" },
		{ name: "pyflakes", command: "python3 -m pyflakes {file}", format: "generic" },
	],
	".go": [{ name: "go vet", command: "go vet ./...", marker: "go.mod", format: "generic" }],
};

export const DEFAULTS: Readonly<DiagnosticsConfig> = {
	enabled: true,
	timeoutMs: 20_000,
	debounceMs: 300,
	maxLines: 20,
	checkers: DEFAULT_CHECKERS,
};

export const PLACEHOLDERS = ["file", "dir", "root", "marker", "relfile", "cwd"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

// -- paths ----------------------------------------------------------------

export function pathFor(platform: string) {
	return platform === "win32" ? win32 : posix;
}

/** Comparable form of a path: normalized, forward slashes, lower-case on Windows. */
export function pathKey(p: string, platform: string): string {
	const P = pathFor(platform);
	let k = P.normalize(p).replace(/[\\/]+/g, "/");
	if (k.length > 1) k = k.replace(/\/+$/, "");
	return platform === "win32" ? k.toLowerCase() : k;
}

export function samePath(a: string, b: string, platform: string): boolean {
	return pathKey(a, platform) === pathKey(b, platform);
}

/** Absolute path of a tool `path` argument: `~` expanded, relative paths taken from cwd. */
export function resolveTarget(p: string, cwd: string, home: string, platform: string): string {
	const P = pathFor(platform);
	let s = p.trim();
	if (s === "~") s = home;
	else if (s.startsWith("~/") || s.startsWith("~\\")) s = P.join(home, s.slice(2));
	return P.resolve(cwd, s);
}

export function extensionOf(file: string, platform: string): string {
	return pathFor(platform).extname(file).toLowerCase();
}

/** Walks up from `startDir` looking for `name`; returns the file's path or undefined. */
export function findUp(startDir: string, name: string, exists: (p: string) => boolean, platform: string): string | undefined {
	const P = pathFor(platform);
	let dir = P.resolve(startDir);
	for (;;) {
		const candidate = P.join(dir, name);
		if (exists(candidate)) return candidate;
		const parent = P.dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/** Path shown to the model: relative to cwd with forward slashes, or absolute when outside it. */
export function displayPath(file: string, cwd: string, platform: string): string {
	const P = pathFor(platform);
	const rel = P.relative(cwd, file);
	const out = !rel || rel.startsWith("..") || P.isAbsolute(rel) ? file : rel;
	return out.replace(/\\/g, "/");
}

// -- command templating ------------------------------------------------------

/** Splits a template into words. Double or single quotes group; there are no escapes. */
export function splitCommand(template: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | undefined;
	let inWord = false;
	for (const ch of template) {
		if (quote) {
			if (ch === quote) quote = undefined;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) out.push(cur);
			cur = "";
			inWord = false;
		} else {
			cur += ch;
			inWord = true;
		}
	}
	if (inWord) out.push(cur);
	return out;
}

/** Placeholder names used in a template, including unknown ones. */
export function placeholdersIn(template: string): string[] {
	return [...template.matchAll(/\{([a-zA-Z_]+)\}/g)].map((m) => m[1]!);
}

export function substitute(token: string, vars: Record<Placeholder, string>): string {
	return token.replace(/\{([a-zA-Z_]+)\}/g, (whole, name: string) => (name in vars ? vars[name as Placeholder] : whole));
}

export interface Plan {
	name: string;
	/** Words after substitution; argv[0] is the binary as written in the template. */
	argv: string[];
	/** Working directory for the command and base for relative paths in its output. */
	root: string;
	format: Format;
	filter: boolean;
	timeoutMs?: number;
}

export interface PlanInput {
	file: string;
	cwd: string;
	exists: (p: string) => boolean;
	platform: string;
}

/**
 * Turns a checker into a concrete plan for `file`, or undefined when the checker does not apply
 * (its marker is missing, it has no fallback, and the command needs {marker}).
 */
export function planCommand(checker: Checker, input: PlanInput): Plan | undefined {
	const P = pathFor(input.platform);
	const dir = P.dirname(input.file);
	const marker = checker.marker ? findUp(dir, checker.marker, input.exists, input.platform) : undefined;
	let template = checker.command;
	let root = input.cwd;
	if (checker.marker) {
		if (marker) root = P.dirname(marker);
		else if (checker.fallback) template = checker.fallback;
		else if (template.includes("{marker}")) return undefined;
	}
	const vars: Record<Placeholder, string> = {
		file: input.file,
		dir,
		root,
		cwd: input.cwd,
		marker: marker ?? "",
		relfile: P.relative(root, input.file) || P.basename(input.file),
	};
	const argv = splitCommand(template).map((t) => substitute(t, vars));
	if (!argv.length) return undefined;
	return {
		name: checker.name ?? P.basename(argv[0]!),
		argv,
		root,
		format: checker.format ?? "generic",
		filter: checker.filter !== false,
		timeoutMs: checker.timeoutMs,
	};
}

// -- binary resolution ---------------------------------------------------------

export interface ResolveOptions {
	platform: string;
	/** Directories whose node_modules/.bin is tried before PATH (project root, then cwd). */
	localDirs: string[];
	env: Record<string, string | undefined>;
	isFile: (p: string) => boolean;
	readFile: (p: string) => string | undefined;
	/** The node executable used to run npm shims directly (process.execPath). */
	nodePath: string;
}

export interface ResolvedBinary {
	command: string;
	/** Leading arguments (the script path when a shim is unwrapped). */
	args: string[];
	via: "local" | "path" | "explicit";
}

const WIN_EXTS = [".com", ".exe", ".bat", ".cmd"];

/**
 * Finds an executable for the template's binary word without a shell, so paths with spaces need
 * no quoting: project-local `node_modules/.bin` first, then PATH (honouring PATHEXT on Windows).
 * npm's `.cmd` shims cannot be spawned directly, so they are unwrapped to `node <script>`.
 * Returns undefined when nothing runnable is found.
 */
export function resolveBinary(bin: string, opts: ResolveOptions): ResolvedBinary | undefined {
	const win = opts.platform === "win32";
	const P = pathFor(opts.platform);
	const runnable = (candidate: string, via: ResolvedBinary["via"]): ResolvedBinary | undefined => {
		if (!opts.isFile(candidate)) return undefined;
		if (win && /\.(cmd|bat)$/i.test(candidate)) {
			const text = opts.readFile(candidate) ?? "";
			const m = /"%dp0%\\([^"]+)"\s+%\*/.exec(text);
			if (m) {
				const script = P.join(P.dirname(candidate), m[1]!);
				if (opts.isFile(script)) return { command: opts.nodePath, args: [script], via };
			}
			return { command: "cmd.exe", args: ["/d", "/c", candidate], via };
		}
		return { command: candidate, args: [], via };
	};
	const exts = win
		? (opts.env.PATHEXT ?? opts.env.Pathext ?? WIN_EXTS.join(";"))
				.split(";")
				.map((e) => e.trim().toLowerCase())
				.filter(Boolean)
		: [];
	const hasExt = win && exts.includes(P.extname(bin).toLowerCase());
	const variants = (base: string) => (win ? [...(hasExt ? [base] : []), ...exts.map((e) => base + e)] : [base]);

	if (P.isAbsolute(bin) || /[\\/]/.test(bin)) {
		const abs = P.resolve(opts.localDirs[0] ?? ".", bin);
		for (const v of variants(abs)) {
			const r = runnable(v, "explicit");
			if (r) return r;
		}
		return undefined;
	}
	for (const dir of opts.localDirs) {
		const base = P.join(dir, "node_modules", ".bin", bin);
		for (const v of variants(base)) {
			const r = runnable(v, "local");
			if (r) return r;
		}
	}
	const pathVar = opts.env.PATH ?? opts.env.Path ?? opts.env.path ?? "";
	for (const dir of pathVar.split(win ? ";" : ":")) {
		if (!dir) continue;
		for (const v of variants(P.join(dir, bin))) {
			const r = runnable(v, "path");
			if (r) return r;
		}
	}
	return undefined;
}

// -- output parsing --------------------------------------------------------------

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
	/** Absolute path, or undefined for diagnostics about the run itself (e.g. a broken tsconfig). */
	file?: string;
	line?: number;
	col?: number;
	severity: Severity;
	code?: string;
	message: string;
}

const TSC_LINE = /^(?:(.+?)\((\d+),(\d+)\): )?(error|warning|message) (TS\d+): (.*)$/;
const PYRIGHT_LINE = /^\s*(.+?):(\d+):(\d+) - (error|warning|information): (.*)$/;
const GENERIC_LINE = /^\s*(?:vet:\s+)?(.+?):(\d+)(?::(\d+))?:?\s+(.*)$/;

function severityOf(word: string): Severity {
	const w = word.toLowerCase();
	return w === "error" ? "error" : w === "warning" ? "warning" : "info";
}

/** Parses checker output. Relative file paths are resolved against `root`, the command's cwd. */
export function parseOutput(text: string, format: Format, opts: { root: string; platform: string }): Diagnostic[] {
	const P = pathFor(opts.platform);
	const abs = (f: string) => P.resolve(opts.root, f.trim());
	const out: Diagnostic[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/\x1b\[[0-9;]*m/g, "");
		if (format === "tsc") {
			const m = TSC_LINE.exec(line);
			if (m) {
				out.push({
					file: m[1] ? abs(m[1]) : undefined,
					line: m[2] ? Number(m[2]) : undefined,
					col: m[3] ? Number(m[3]) : undefined,
					severity: severityOf(m[4]!),
					code: m[5],
					message: m[6]!.trim(),
				});
			} else if (/^\s+\S/.test(line) && out.length) {
				out[out.length - 1]!.message += ` ${line.trim()}`;
			}
		} else if (format === "pyright") {
			const m = PYRIGHT_LINE.exec(line);
			if (!m) continue;
			const codeMatch = /\s\((report\w+)\)$/.exec(m[5]!);
			out.push({
				file: abs(m[1]!),
				line: Number(m[2]),
				col: Number(m[3]),
				severity: severityOf(m[4]!),
				code: codeMatch?.[1],
				message: (codeMatch ? m[5]!.slice(0, codeMatch.index) : m[5]!).trim(),
			});
		} else {
			if (!line.trim() || /^\s*#/.test(line)) continue;
			const m = GENERIC_LINE.exec(line);
			if (!m) continue;
			let message = m[4]!.trim();
			let severity: Severity = "error";
			const sev = /^(error|warning|note|info|information)\s*:\s*/i.exec(message);
			if (sev) {
				severity = severityOf(sev[1]!);
				message = message.slice(sev[0].length);
			}
			out.push({ file: abs(m[1]!), line: Number(m[2]), col: m[3] ? Number(m[3]) : undefined, severity, message });
		}
	}
	return out;
}

/** Keeps diagnostics about `file`, plus file-less ones, which concern the whole run. */
export function filterToFile(diags: Diagnostic[], file: string, platform: string): Diagnostic[] {
	return diags.filter((d) => !d.file || samePath(d.file, file, platform));
}

export interface Counts {
	errors: number;
	warnings: number;
	infos: number;
}

export function summarize(diags: Diagnostic[]): Counts {
	const c: Counts = { errors: 0, warnings: 0, infos: 0 };
	for (const d of diags) {
		if (d.severity === "error") c.errors++;
		else if (d.severity === "warning") c.warnings++;
		else c.infos++;
	}
	return c;
}

export function countText(c: Counts): string {
	const parts: string[] = [];
	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
	if (c.errors) parts.push(plural(c.errors, "error"));
	if (c.warnings) parts.push(plural(c.warnings, "warning"));
	if (c.infos) parts.push(plural(c.infos, "note"));
	return parts.length ? parts.join(", ") : "no errors";
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

/** The block appended to a tool result. Empty string when there is nothing to report. */
export function renderBlock(name: string, diags: Diagnostic[], opts: { cwd: string; maxLines: number; platform: string }): string {
	if (!diags.length) return "";
	const lines = [`Diagnostics (${name}): ${countText(summarize(diags))}`];
	const max = Math.max(1, opts.maxLines);
	for (const d of diags.slice(0, max)) {
		const loc = d.file ? `${displayPath(d.file, opts.cwd, opts.platform)}:${d.line ?? 0}:${d.col ?? 0}` : "(global)";
		const sev = d.severity === "error" ? "" : ` ${d.severity}`;
		lines.push(`  ${loc}${sev}${d.code ? ` ${d.code}` : ""} ${truncate(d.message.replace(/\s+/g, " "), 400)}`);
	}
	if (diags.length > max) lines.push(`  ... ${diags.length - max} more`);
	return lines.join("\n");
}

/** Footer text, e.g. `diag: tsc 2 errors` or `diag: tsc ok`. */
export function statusText(name: string, counts: Counts): string {
	return counts.errors || counts.warnings ? `diag: ${name} ${countText(counts)}` : `diag: ${name} ok`;
}

// -- config ----------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numberField(v: unknown, name: string): { value?: number; error?: string } {
	if (v === undefined) return {};
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return { error: `${name} must be a non-negative number` };
	return { value: n };
}

export function normalizeExtension(key: string): string | undefined {
	const k = key.trim().toLowerCase();
	const ext = k.startsWith(".") ? k : `.${k}`;
	return /^\.[a-z0-9][a-z0-9_+.-]*$/.test(ext) ? ext : undefined;
}

const CHECKER_KEYS = new Set(["name", "command", "marker", "fallback", "format", "filter", "timeoutMs"]);

function validateChecker(raw: unknown, where: string): { checker?: Checker; error?: string } {
	if (!isRecord(raw)) return { error: `${where} must be an object with a "command"` };
	for (const k of Object.keys(raw)) if (!CHECKER_KEYS.has(k)) return { error: `${where}: unknown key "${k}"` };
	if (typeof raw.command !== "string" || !raw.command.trim()) return { error: `${where}: "command" must be a non-empty string` };
	for (const k of ["name", "marker", "fallback"] as const) {
		if (raw[k] !== undefined && (typeof raw[k] !== "string" || !raw[k].trim())) return { error: `${where}: "${k}" must be a non-empty string` };
	}
	if (raw.format !== undefined && !FORMATS.includes(raw.format as Format)) {
		return { error: `${where}: "format" must be one of ${FORMATS.join(", ")}` };
	}
	if (raw.filter !== undefined && typeof raw.filter !== "boolean") return { error: `${where}: "filter" must be true or false` };
	const t = numberField(raw.timeoutMs, `${where}: "timeoutMs"`);
	if (t.error) return { error: t.error };
	for (const [field, tpl] of [
		["command", raw.command],
		["fallback", raw.fallback],
	] as const) {
		if (typeof tpl !== "string") continue;
		if (!splitCommand(tpl).length) return { error: `${where}: "${field}" has no words` };
		const unknown = placeholdersIn(tpl).find((p) => !(PLACEHOLDERS as readonly string[]).includes(p));
		if (unknown) return { error: `${where}: "${field}" uses unknown placeholder {${unknown}}` };
	}
	if (typeof raw.fallback === "string" && raw.fallback.includes("{marker}")) {
		return { error: `${where}: "fallback" runs when the marker is missing, so it cannot use {marker}` };
	}
	if (raw.fallback !== undefined && raw.marker === undefined) return { error: `${where}: "fallback" needs a "marker"` };
	const checker: Checker = { command: raw.command };
	if (typeof raw.name === "string") checker.name = raw.name;
	if (typeof raw.marker === "string") checker.marker = raw.marker;
	if (typeof raw.fallback === "string") checker.fallback = raw.fallback;
	if (raw.format !== undefined) checker.format = raw.format as Format;
	if (raw.filter !== undefined) checker.filter = raw.filter as boolean;
	if (t.value !== undefined) checker.timeoutMs = t.value;
	return { checker };
}

const CONFIG_KEYS = new Set(["enabled", "timeoutMs", "debounceMs", "maxLines", "checkers"]);

/**
 * Coerces a parsed config file into a full config (user checkers merged over the defaults;
 * `false` or `null` removes an extension's default), reporting the first problem instead.
 */
export function validateConfig(raw: unknown): { config?: DiagnosticsConfig; error?: string } {
	if (!isRecord(raw)) return { error: "config must be a JSON object" };
	for (const k of Object.keys(raw)) if (!CONFIG_KEYS.has(k)) return { error: `unknown key "${k}"` };
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return { error: `"enabled" must be true or false` };
	const nums: Partial<Record<"timeoutMs" | "debounceMs" | "maxLines", number>> = {};
	for (const k of ["timeoutMs", "debounceMs", "maxLines"] as const) {
		const r = numberField(raw[k], `"${k}"`);
		if (r.error) return { error: r.error };
		if (r.value !== undefined) nums[k] = r.value;
	}
	const checkers: Record<string, Checker[]> = { ...DEFAULT_CHECKERS };
	if (raw.checkers !== undefined) {
		if (!isRecord(raw.checkers)) return { error: `"checkers" must be an object keyed by file extension` };
		for (const [key, value] of Object.entries(raw.checkers)) {
			const ext = normalizeExtension(key);
			if (!ext) return { error: `checkers: "${key}" is not a file extension` };
			if (value === false || value === null) {
				delete checkers[ext];
				continue;
			}
			const list = Array.isArray(value) ? value : [value];
			if (!list.length) return { error: `checkers["${key}"] is empty; use false to disable` };
			const parsed: Checker[] = [];
			for (let i = 0; i < list.length; i++) {
				const r = validateChecker(list[i], `checkers["${key}"]${Array.isArray(value) ? `[${i}]` : ""}`);
				if (r.error) return { error: r.error };
				parsed.push(r.checker!);
			}
			checkers[ext] = parsed;
		}
	}
	return {
		config: {
			enabled: raw.enabled !== false,
			timeoutMs: nums.timeoutMs ?? DEFAULTS.timeoutMs,
			debounceMs: nums.debounceMs ?? DEFAULTS.debounceMs,
			maxLines: nums.maxLines ?? DEFAULTS.maxLines,
			checkers,
		},
	};
}

export function checkersFor(file: string, config: DiagnosticsConfig, platform: string): Checker[] {
	return config.checkers[extensionOf(file, platform)] ?? [];
}

// -- coalescing ------------------------------------------------------------------

interface Waiter {
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
}

interface Entry {
	fn: () => Promise<unknown>;
	timer?: NodeJS.Timeout;
	running: boolean;
	waiters: Waiter[];
}

/**
 * Runs at most one job per key at a time. Calls arriving within `delayMs` of each other share one
 * run; calls arriving while a run is in flight share the next run, which starts after it finishes.
 * So a burst of edits to one project costs one check, and no caller gets a result computed from
 * before its edit landed.
 */
export class Coalescer {
	private readonly entries = new Map<string, Entry>();
	private readonly delayMs: number;

	constructor(delayMs: number) {
		this.delayMs = delayMs;
	}

	run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let e = this.entries.get(key);
			if (!e) {
				e = { fn, running: false, waiters: [] };
				this.entries.set(key, e);
			}
			e.fn = fn;
			e.waiters.push({ resolve: resolve as (v: unknown) => void, reject });
			if (!e.running) this.arm(key, e);
		});
	}

	/** Number of keys with a pending or running job. */
	get size(): number {
		return this.entries.size;
	}

	private arm(key: string, e: Entry): void {
		if (e.timer) clearTimeout(e.timer);
		// Not unref'd on purpose: while a tool_result handler awaits this timer it may be the only
		// thing keeping the event loop alive, and a headless `pi -p` run would exit mid-check.
		e.timer = setTimeout(() => void this.fire(key, e), this.delayMs);
	}

	private async fire(key: string, e: Entry): Promise<void> {
		e.timer = undefined;
		const waiters = e.waiters;
		const fn = e.fn;
		e.waiters = [];
		e.running = true;
		try {
			const v = await fn();
			for (const w of waiters) w.resolve(v);
		} catch (err) {
			for (const w of waiters) w.reject(err);
		}
		e.running = false;
		if (e.waiters.length) this.arm(key, e);
		else this.entries.delete(key);
	}
}
