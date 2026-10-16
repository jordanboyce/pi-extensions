/**
 * Pure logic for pi-env-switch: config shapes, repo matching, value resolution,
 * env apply/restore and secret redaction. No pi imports so it can be unit tested.
 */

export interface Profile {
	description?: string;
	/** Shown as a warning when the profile activates, e.g. "PRODUCTION billing". */
	warn?: string;
	/** Variables to set. Values: literal, `${VAR}` interpolation, `!command`, or `file:path`. */
	env?: Record<string, string>;
	/** Variables to remove from the process while this profile is active. */
	unset?: string[];
	/** Extra variable names (beyond the KEY/TOKEN/SECRET heuristic) whose values are redacted. */
	redact?: string[];
}

export interface Rule {
	profile: string;
	/** Globs against the normalized remote URL, e.g. `github.com/acme/*`. */
	remote?: string | string[];
	/** Globs against git remote *names*, e.g. `acme-*`. Matches if any remote matches. */
	remoteName?: string | string[];
	/** Globs against the absolute repo root path, e.g. `**\/work/acme/**` (no `~` expansion). */
	path?: string | string[];
	/** Globs against the repo name (last URL segment, or folder name). */
	repo?: string | string[];
}

export interface EnvSwitchConfig {
	profiles: Record<string, Profile>;
	rules?: Rule[];
	/** Profile used when nothing else matches. Omit to leave the environment untouched. */
	default?: string;
	/** Redact secret values from tool output before the model sees them. Default true. */
	redact?: boolean;
}

export interface RepoIdentity {
	root: string;
	repoName: string;
	/** Normalized, credential-free remote URL of the primary remote, if any. */
	remote?: string;
	remoteNames: string[];
}

export type ProfileSource = "flag" | "env" | "pin" | "rule" | "default" | "manual";

export interface Selection {
	name: string;
	source: ProfileSource;
}

// ---------------------------------------------------------------------------
// Normalization + matching
// ---------------------------------------------------------------------------

/** `git@github.com:Acme/Repo.git`, `https://user:tok@github.com/Acme/Repo.git` -> `github.com/acme/repo` */
export function normalizeRemoteUrl(url: string): string {
	let s = url.trim();
	if (!s) return "";
	s = s.replace(/^[a-z+]+:\/\//i, ""); // scheme
	s = s.replace(/^[^@/]+@/, ""); // user[:password]@ (also drops scp-style `git@`)
	s = s.replace(/^([^/:]+):(?!\d+\/)/, "$1/"); // scp-style host:path -> host/path
	s = s.replace(/^([^/:]+):\d+\//, "$1/"); // host:port/path -> host/path
	s = s.replace(/\.git$/i, "").replace(/\/+$/, "");
	return s.toLowerCase();
}

export function normalizePath(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function repoNameFromRemote(remote: string): string {
	const last = remote.split("/").filter(Boolean).pop();
	return last ?? "";
}

export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob.charAt(i);
		if (c === "*") {
			if (glob.charAt(i + 1) === "*") {
				re += ".*";
				i++;
			} else {
				re += "[^/]*";
			}
		} else if (c === "?") {
			re += "[^/]";
		} else {
			re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	return new RegExp(`^${re}$`, "i");
}

function asList(v: string | string[] | undefined): string[] {
	return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function anyMatch(patterns: string[], candidates: string[], normalize: (s: string) => string): boolean {
	return patterns.some((p) => {
		const re = globToRegExp(normalize(p));
		return candidates.some((c) => re.test(c));
	});
}

/** All fields present on a rule must match (AND); within a field any pattern may match (OR). */
export function ruleMatches(rule: Rule, repo: RepoIdentity): boolean {
	const checks: boolean[] = [];
	const remote = asList(rule.remote);
	if (remote.length) checks.push(!!repo.remote && anyMatch(remote, [repo.remote], normalizeRemoteUrl));
	const names = asList(rule.remoteName);
	if (names.length) checks.push(anyMatch(names, repo.remoteNames, (s) => s));
	const paths = asList(rule.path);
	if (paths.length) checks.push(anyMatch(paths, [normalizePath(repo.root)], normalizePath));
	const repos = asList(rule.repo);
	if (repos.length) checks.push(anyMatch(repos, [repo.repoName], (s) => s));
	return checks.length > 0 && checks.every(Boolean);
}

export interface SelectInput {
	config: EnvSwitchConfig;
	repo: RepoIdentity;
	flag?: string;
	envVar?: string;
	pinned?: string;
}

/** Precedence: --env-profile flag > PI_ENV_PROFILE > .pi/env-profile pin > first matching rule > default. */
export function selectProfile(input: SelectInput): Selection | undefined {
	const { config, repo } = input;
	if (input.flag) return { name: input.flag, source: "flag" };
	if (input.envVar) return { name: input.envVar, source: "env" };
	if (input.pinned) return { name: input.pinned, source: "pin" };
	for (const rule of config.rules ?? []) {
		if (ruleMatches(rule, repo)) return { name: rule.profile, source: "rule" };
	}
	if (config.default) return { name: config.default, source: "default" };
	return undefined;
}

/** First non-empty, non-comment line of a `.pi/env-profile` pin file. */
export function parsePin(text: string): string | undefined {
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (t && !t.startsWith("#")) return t;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Value resolution
// ---------------------------------------------------------------------------

export interface ResolveDeps {
	env: NodeJS.ProcessEnv;
	/** Runs a shell command line, returning trimmed stdout. Throw on failure. */
	runCommand: (commandLine: string) => Promise<string>;
	readFile: (path: string) => Promise<string>;
}

/** Interpolates `${VAR}` against the *original* environment. Throws on a missing variable. */
export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
		const v = env[name];
		if (v === undefined || v === "") throw new Error(`\${${name}} is not set`);
		return v;
	});
}

export async function resolveValue(raw: string, deps: ResolveDeps): Promise<string> {
	if (raw.startsWith("!")) {
		const out = await deps.runCommand(raw.slice(1).trim());
		return out.trim();
	}
	if (raw.startsWith("file:")) {
		const out = await deps.readFile(interpolate(raw.slice(5).trim(), deps.env));
		return out.trim();
	}
	return interpolate(raw, deps.env);
}

export interface ResolvedProfile {
	name: string;
	profile: Profile;
	values: Record<string, string>;
	errors: string[];
}

export async function resolveProfile(name: string, config: EnvSwitchConfig, deps: ResolveDeps): Promise<ResolvedProfile> {
	const profile = config.profiles[name];
	if (!profile) throw new Error(`Unknown profile "${name}". Known: ${Object.keys(config.profiles).join(", ") || "(none)"}`);
	const values: Record<string, string> = {};
	const errors: string[] = [];
	for (const [key, raw] of Object.entries(profile.env ?? {})) {
		try {
			const v = await resolveValue(raw, deps);
			if (!v) throw new Error("resolved to an empty value");
			values[key] = v;
		} catch (e) {
			errors.push(`${key}: ${(e as Error).message}`);
		}
	}
	return { name, profile, values, errors };
}

// ---------------------------------------------------------------------------
// Apply / restore
// ---------------------------------------------------------------------------

/** Tracks the original value of every variable it touches so a profile can be fully undone. */
export class EnvApplier {
	private originals = new Map<string, string | undefined>();
	private env: NodeJS.ProcessEnv;

	constructor(env: NodeJS.ProcessEnv) {
		this.env = env;
	}

	get active(): boolean {
		return this.originals.size > 0;
	}

	apply(values: Record<string, string>, unset: string[] = []): void {
		for (const [key, value] of Object.entries(values)) {
			this.remember(key);
			this.env[key] = value;
		}
		for (const key of unset) {
			if (key in values) continue; // an explicit set wins over unset
			this.remember(key);
			delete this.env[key];
		}
	}

	restore(): void {
		for (const [key, original] of this.originals) {
			if (original === undefined) delete this.env[key];
			else this.env[key] = original;
		}
		this.originals.clear();
	}

	private remember(key: string): void {
		if (!this.originals.has(key)) this.originals.set(key, this.env[key]);
	}
}

// ---------------------------------------------------------------------------
// Redaction + display
// ---------------------------------------------------------------------------

/** Variable names that are treated as secrets even when the value is too short to redact. */
export const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)/i;
const MIN_SECRET_LENGTH = 8;

/** Which resolved variables count as secrets: name heuristic plus the profile's explicit `redact` list. */
export function secretsOf(resolved: ResolvedProfile): Record<string, string> {
	const explicit = new Set((resolved.profile.redact ?? []).map((s) => s.toUpperCase()));
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(resolved.values)) {
		if (value.length < MIN_SECRET_LENGTH) continue;
		if (SECRET_NAME.test(name) || explicit.has(name.toUpperCase())) out[name] = value;
	}
	return out;
}

export function redactText(text: string, secrets: Record<string, string>): string {
	let out = text;
	const entries = Object.entries(secrets).sort((a, b) => b[1].length - a[1].length);
	for (const [name, value] of entries) {
		if (out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
	}
	return out;
}

/**
 * Redacts every string inside a JSON value (tool `structuredContent`, config dumps parsed as
 * JSON). Returns the same reference when nothing changed so callers can skip a no-op replace.
 */
export function redactJson<T>(value: T, secrets: Record<string, string>): T {
	if (typeof value === "string") return redactText(value, secrets) as T;
	if (Array.isArray(value)) {
		let changed = false;
		const next = value.map((item) => {
			const r = redactJson(item, secrets);
			if (r !== item) changed = true;
			return r;
		});
		return (changed ? next : value) as T;
	}
	if (value && typeof value === "object") {
		let changed = false;
		const next: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const r = redactJson(v, secrets);
			if (r !== v) changed = true;
			next[k] = r;
		}
		return (changed ? next : value) as T;
	}
	return value;
}

/** `…1234` fingerprint so you can tell keys apart without exposing them. */
export function fingerprint(value: string): string {
	return value.length >= 12 ? `…${value.slice(-4)}` : "set";
}

/** Env var -> pi provider id, used only to hint when auth.json may shadow a switched key. */
export const PROVIDER_ENV: Record<string, string> = {
	ANTHROPIC_API_KEY: "anthropic",
	OPENAI_API_KEY: "openai",
	GEMINI_API_KEY: "google",
	GROQ_API_KEY: "groq",
	MISTRAL_API_KEY: "mistral",
	XAI_API_KEY: "xai",
	OPENROUTER_API_KEY: "openrouter",
	DEEPSEEK_API_KEY: "deepseek",
	TOGETHER_API_KEY: "together",
	FIREWORKS_API_KEY: "fireworks",
};

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

function isStringList(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isGlobField(v: unknown): boolean {
	return v === undefined || typeof v === "string" || isStringList(v);
}

/** Checks shape and references so a typo surfaces as one clear message instead of a crash mid-activation. */
export function validateConfig(raw: unknown): { config?: EnvSwitchConfig; error?: string } {
	if (!isPlainObject(raw)) return { error: "config must be a JSON object" };
	const c = raw;
	if (!isPlainObject(c.profiles)) return { error: '"profiles" object is required' };
	for (const [name, p] of Object.entries(c.profiles)) {
		if (!isPlainObject(p)) return { error: `profiles.${name} must be an object` };
		if (p.env !== undefined && !isPlainObject(p.env)) return { error: `profiles.${name}.env must be an object` };
		for (const [k, v] of Object.entries(p.env ?? {})) {
			if (typeof v !== "string") return { error: `profiles.${name}.env.${k} must be a string` };
			if (!VAR_NAME.test(k)) return { error: `profiles.${name}.env has invalid variable name "${k}"` };
		}
		for (const field of ["unset", "redact"] as const) {
			if (p[field] !== undefined && !isStringList(p[field])) return { error: `profiles.${name}.${field} must be an array of strings` };
		}
		for (const field of ["description", "warn"] as const) {
			if (p[field] !== undefined && typeof p[field] !== "string") return { error: `profiles.${name}.${field} must be a string` };
		}
	}
	if (c.rules !== undefined && !Array.isArray(c.rules)) return { error: '"rules" must be an array' };
	for (const [i, r] of (c.rules ?? []).entries()) {
		if (!isPlainObject(r)) return { error: `rules[${i}] must be an object` };
		if (typeof r.profile !== "string" || !c.profiles[r.profile]) return { error: `rules[${i}] references unknown profile "${String(r.profile)}"` };
		for (const field of ["remote", "remoteName", "path", "repo"] as const) {
			if (!isGlobField(r[field])) return { error: `rules[${i}].${field} must be a string or an array of strings` };
		}
	}
	if (c.default !== undefined && (typeof c.default !== "string" || !c.profiles[c.default])) {
		return { error: `default references unknown profile "${String(c.default)}"` };
	}
	if (c.redact !== undefined && typeof c.redact !== "boolean") return { error: '"redact" must be true or false' };
	return { config: c as unknown as EnvSwitchConfig };
}
