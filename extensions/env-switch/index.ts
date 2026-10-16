/**
 * pi-env-switch
 *
 * Switches the process environment (API keys, service tokens) per repository so
 * production keys and billing tiers don't get mixed up between projects.
 *
 * Profiles live in ~/.pi/agent/env-profiles.json (never in a repo). A repo can
 * only *name* a profile (`.pi/env-profile`) or be matched by a rule; it can never
 * define values, so cloning an untrusted repo can't inject variables or commands.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	EnvApplier,
	fingerprint,
	normalizeRemoteUrl,
	parsePin,
	PROVIDER_ENV,
	redactText,
	repoNameFromRemote,
	resolveProfile,
	secretsOf,
	selectProfile,
	validateConfig,
	type EnvSwitchConfig,
	type RepoIdentity,
	type ResolvedProfile,
	type ResolveDeps,
	type Selection,
} from "./profiles.ts";

const STATUS_KEY = "env-switch";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function configPath(): string {
	return process.env.PI_ENV_PROFILES_FILE || join(agentDir(), "env-profiles.json");
}

async function readJson(path: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
}

export default function envSwitch(pi: ExtensionAPI) {
	const applier = new EnvApplier(process.env);
	let current: { selection: Selection; resolved: ResolvedProfile; secrets: Record<string, string> } | undefined;
	let config: EnvSwitchConfig | undefined;
	let repo: RepoIdentity | undefined;
	let warnedShadow = false;

	pi.registerFlag("env-profile", {
		description: "pi-env-switch: force a profile by name for this run",
		type: "string",
	});

	// -- helpers ------------------------------------------------------------

	async function git(cwd: string, args: string[]): Promise<string | undefined> {
		try {
			const r = await pi.exec("git", args, { cwd, timeout: 5000 });
			return r.code === 0 ? r.stdout.trim() : undefined;
		} catch {
			return undefined;
		}
	}

	async function identify(cwd: string): Promise<RepoIdentity> {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd;
		const names = ((await git(root, ["remote"])) ?? "").split(/\r?\n/).filter(Boolean);
		const primary = names.includes("origin") ? "origin" : names[0];
		const url = primary ? await git(root, ["remote", "get-url", primary]) : undefined;
		const remote = url ? normalizeRemoteUrl(url) : undefined;
		return {
			root,
			remote,
			remoteNames: names,
			repoName: (remote && repoNameFromRemote(remote)) || basename(root).toLowerCase(),
		};
	}

	/** `${VAR}` references see `baseEnv`: the user's real environment, captured after any previous profile is undone. */
	function deps(baseEnv: NodeJS.ProcessEnv): ResolveDeps {
		return {
			env: baseEnv,
			readFile: (p) => readFile(p, "utf8"),
			runCommand: async (line) => {
				const win = process.platform === "win32";
				const r = await pi.exec(win ? "cmd.exe" : "sh", win ? ["/d", "/s", "/c", line] : ["-c", line], { timeout: 15000 });
				if (r.code !== 0) throw new Error(`command exited ${r.code}`);
				return r.stdout;
			},
		};
	}

	function clear(ctx: ExtensionContext): void {
		applier.restore();
		current = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	async function loadConfig(): Promise<{ config?: EnvSwitchConfig; error?: string }> {
		try {
			const raw = await readJson(configPath());
			if (raw === undefined) return {};
			return validateConfig(raw);
		} catch (e) {
			return { error: `could not read ${configPath()}: ${(e as Error).message}` };
		}
	}

	async function activate(ctx: ExtensionContext, manual?: string): Promise<void> {
		// Validate before touching anything, so a typo in `/env use` or a broken config keeps the working profile.
		const loaded = await loadConfig();
		if (loaded.error) {
			ctx.ui.notify(`env-switch: ${loaded.error}`, "error");
			return;
		}
		if (manual && !loaded.config?.profiles[manual]) {
			const known = Object.keys(loaded.config?.profiles ?? {}).join(", ") || "(none)";
			ctx.ui.notify(`env-switch: unknown profile "${manual}". Known: ${known}`, "error");
			return;
		}
		config = loaded.config;

		applier.restore();
		const baseEnv = { ...process.env };
		current = undefined;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);

		repo = await identify(ctx.cwd);
		const flag = pi.getFlag("env-profile");
		const pinned = parsePin((await readFile(join(repo.root, ".pi", "env-profile"), "utf8").catch(() => "")) ?? "");

		let selection: Selection | undefined;
		if (manual) {
			selection = { name: manual, source: "manual" };
		} else if (config) {
			selection = selectProfile({
				config,
				repo,
				flag: typeof flag === "string" && flag ? flag : undefined,
				envVar: process.env.PI_ENV_PROFILE || undefined,
				pinned,
			});
		} else if (pinned || (typeof flag === "string" && flag)) {
			ctx.ui.notify(`env-switch: a profile was requested but ${configPath()} does not exist`, "warning");
		}
		if (!selection) return;
		if (!config) {
			ctx.ui.notify(`env-switch: no config at ${configPath()}`, "warning");
			return;
		}

		let resolved: ResolvedProfile;
		try {
			resolved = await resolveProfile(selection.name, config, deps(baseEnv));
		} catch (e) {
			ctx.ui.notify(`env-switch: ${(e as Error).message}`, "error");
			return;
		}

		applier.apply(resolved.values, resolved.profile.unset);
		current = { selection, resolved, secrets: config.redact === false ? {} : secretsOf(resolved) };

		if (ctx.hasUI) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(resolved.profile.warn ? "warning" : "dim", `env:${resolved.name}`));
		}
		if (resolved.errors.length) {
			ctx.ui.notify(`env-switch: ${resolved.name}: could not resolve\n  ${resolved.errors.join("\n  ")}`, "warning");
		}
		if (resolved.profile.warn) ctx.ui.notify(`env-switch: ${resolved.name}: ${resolved.profile.warn}`, "warning");
		await warnIfShadowed(ctx, resolved);
	}

	/** auth.json credentials may outrank environment variables; flag that instead of silently using the wrong key. */
	async function warnIfShadowed(ctx: ExtensionContext, resolved: ResolvedProfile): Promise<void> {
		if (warnedShadow) return;
		try {
			const auth = (await readJson(join(agentDir(), "auth.json"))) as Record<string, unknown> | undefined;
			if (!auth) return;
			const shadowed = Object.keys(resolved.values)
				.map((k) => PROVIDER_ENV[k])
				.filter((p): p is string => !!p && p in auth);
			if (shadowed.length) {
				warnedShadow = true;
				ctx.ui.notify(
					`env-switch: auth.json has stored credentials for ${shadowed.join(", ")}. ` +
						`If pi keeps using the old key, run /logout for that provider so the profile's key is used.`,
					"warning",
				);
			}
		} catch {
			/* advisory only */
		}
	}

	// -- lifecycle ----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		await activate(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clear(ctx);
	});

	// Keep secrets out of model-visible tool output (e.g. `env`, `printenv`, config dumps).
	pi.on("tool_result", (event) => {
		const secrets = current?.secrets;
		if (!secrets || Object.keys(secrets).length === 0) return;
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = redactText(part.text, secrets);
			if (text !== part.text) changed = true;
			return text === part.text ? part : { ...part, text };
		});
		return changed ? { content } : undefined;
	});

	// -- commands -----------------------------------------------------------

	function describe(): string {
		if (!current) {
			return `No profile active.\nConfig: ${configPath()}${config ? "" : " (not found)"}\nRepo: ${repo?.repoName ?? "?"}${repo?.remote ? ` (${repo.remote})` : ""}`;
		}
		const { selection, resolved } = current;
		const lines = [
			`Profile: ${resolved.name} (via ${selection.source})`,
			...(resolved.profile.description ? [resolved.profile.description] : []),
			`Repo: ${repo?.repoName ?? "?"}${repo?.remote ? ` (${repo.remote})` : ""}`,
			"Set:",
			...Object.entries(resolved.values).map(([k, v]) => `  ${k} = ${fingerprint(v)}`),
		];
		if (resolved.profile.unset?.length) lines.push(`Unset: ${resolved.profile.unset.join(", ")}`);
		if (resolved.errors.length) lines.push("Unresolved:", ...resolved.errors.map((e) => `  ${e}`));
		return lines.join("\n");
	}

	pi.registerCommand("env", {
		description: "Show or switch the active env profile: /env [status|list|use <name>|off|reload]",
		getArgumentCompletions: (prefix) => {
			const [sub = "", arg] = prefix.split(/\s+/);
			if (arg !== undefined && sub === "use" && config) {
				return Object.keys(config.profiles)
					.filter((n) => n.startsWith(arg))
					.map((n) => ({ value: `use ${n}`, label: n }));
			}
			const subs = ["status", "list", "use", "off", "reload"].filter((s) => s.startsWith(prefix));
			return subs.length ? subs.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			switch (sub) {
				case "status":
					ctx.ui.notify(describe(), "info");
					return;
				case "list": {
					const names = Object.entries(config?.profiles ?? {}).map(
						([n, p]) => `${n === current?.resolved.name ? "*" : " "} ${n}${p.description ? ` - ${p.description}` : ""}`,
					);
					ctx.ui.notify(names.length ? names.join("\n") : `No profiles. Create ${configPath()}`, "info");
					return;
				}
				case "use": {
					let name = rest[0];
					if (!name && ctx.hasUI && config) name = (await ctx.ui.select("Env profile", Object.keys(config.profiles))) ?? "";
					if (!name) {
						ctx.ui.notify("Usage: /env use <profile>", "warning");
						return;
					}
					await activate(ctx, name);
					ctx.ui.notify(describe(), "info");
					return;
				}
				case "off":
					clear(ctx);
					ctx.ui.notify("Environment restored; no profile active.", "info");
					return;
				case "reload":
					await activate(ctx);
					ctx.ui.notify(describe(), "info");
					return;
				default:
					ctx.ui.notify("Usage: /env [status|list|use <name>|off|reload]", "warning");
			}
		},
	});
}
