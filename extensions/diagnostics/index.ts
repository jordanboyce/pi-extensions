/**
 * pi-diagnostics
 *
 * After every successful `edit` or `write`, runs a type checker / linter for the touched file
 * (tsc, pyright or pyflakes, go vet by default) and appends its findings to the tool result, so
 * the model sees breakage it just introduced instead of discovering it at the next test run.
 *
 *   /diagnostics [status|on|off|run <file>]
 *
 * Config (optional): ~/.pi/agent/diagnostics.json  -  see checkers.ts DiagnosticsConfig.
 * Disable per run with PI_DIAGNOSTICS=off.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Coalescer,
	checkersFor,
	DEFAULTS,
	type Diagnostic,
	type DiagnosticsConfig,
	filterToFile,
	parseOutput,
	planCommand,
	renderBlock,
	resolveBinary,
	resolveTarget,
	statusText,
	summarize,
	validateConfig,
} from "./checkers.ts";

const STATUS_KEY = "diagnostics";

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "diagnostics.json");
}

/** A missing file means defaults; a broken one is reported (and defaults are used) rather than silently ignored. */
async function loadConfig(): Promise<{ config: DiagnosticsConfig; error?: string }> {
	let text: string;
	try {
		text = await readFile(configPath(), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: DEFAULTS };
		return { config: DEFAULTS, error: `could not read ${configPath()}: ${(e as Error).message}` };
	}
	try {
		const r = validateConfig(JSON.parse(text));
		return r.error ? { config: DEFAULTS, error: `${configPath()}: ${r.error}` } : { config: r.config! };
	} catch (e) {
		return { config: DEFAULTS, error: `${configPath()} is not valid JSON: ${(e as Error).message}` };
	}
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function readText(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return undefined;
	}
}

export interface CheckOutcome {
	name: string;
	diagnostics: Diagnostic[];
}

export default function diagnostics(pi: ExtensionAPI) {
	let config: DiagnosticsConfig = DEFAULTS;
	let enabled = true;
	let coalescer = new Coalescer(config.debounceMs);
	/** Binaries already found missing this session, so each is reported once and then skipped. */
	const missing = new Set<string>();
	const noticed = new Set<string>();
	let last: CheckOutcome | undefined;

	function notifyOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (noticed.has(key)) return;
		noticed.add(key);
		ctx.ui.notify(`diagnostics: ${message}`, "warning");
	}

	function showStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!enabled) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "diag: off"));
		else if (last) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", statusText(last.name, summarize(last.diagnostics))));
		else ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	/**
	 * Runs the first applicable checker whose binary exists. Returns undefined when no checker
	 * applies, the binary is missing, or the run timed out; those are reported once and never
	 * turn into content the model sees.
	 */
	async function check(ctx: ExtensionContext, file: string): Promise<CheckOutcome | undefined> {
		const platform = process.platform;
		for (const checker of checkersFor(file, config, platform)) {
			const plan = planCommand(checker, { file, cwd: ctx.cwd, exists: existsSync, platform });
			if (!plan) continue;
			const bin = plan.argv[0]!;
			if (missing.has(bin)) continue;
			const resolved = resolveBinary(bin, {
				platform,
				localDirs: [plan.root, ctx.cwd],
				env: process.env,
				isFile,
				readFile: readText,
				nodePath: process.execPath,
			});
			if (!resolved) {
				missing.add(bin);
				notifyOnce(ctx, `missing:${bin}`, `"${bin}" not found; skipping ${plan.name} checks this session (install it or edit ${configPath()}).`);
				continue;
			}
			const args = [...resolved.args, ...plan.argv.slice(1)];
			const timeout = plan.timeoutMs ?? config.timeoutMs;
			const key = [plan.root, resolved.command, ...args].join("\u0000");
			const result = await coalescer.run(key, () => pi.exec(resolved.command, args, { cwd: plan.root, timeout }));
			if (result.killed) {
				notifyOnce(ctx, `timeout:${plan.name}`, `${plan.name} took longer than ${Math.round(timeout / 1000)} s and was stopped; raise "timeoutMs" in ${configPath()} if the project is large.`);
				return undefined;
			}
			const all = parseOutput(`${result.stdout}\n${result.stderr}`, plan.format, { root: plan.root, platform });
			let diags = plan.filter ? filterToFile(all, file, platform) : all;
			if (!all.length && result.code !== 0) {
				// The checker itself failed (bad config, crash): say so in one line rather than hiding it.
				const first = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).find((l) => l.trim()) ?? `exit code ${result.code}`;
				diags = [{ severity: "error", message: `${plan.name} failed: ${first.trim()}` }];
			}
			return { name: plan.name, diagnostics: diags };
		}
		return undefined;
	}

	function targetOf(input: Record<string, unknown>, ctx: ExtensionContext): string | undefined {
		const p = input.path;
		if (typeof p !== "string" || !p.trim()) return undefined;
		return resolveTarget(p, ctx.cwd, homedir(), process.platform);
	}

	// -- lifecycle ----------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig();
		config = loaded.config;
		coalescer = new Coalescer(config.debounceMs);
		if (loaded.error) ctx.ui.notify(`diagnostics: ${loaded.error} (using defaults)`, "warning");
		enabled = config.enabled && process.env.PI_DIAGNOSTICS?.toLowerCase() !== "off";
		last = undefined;
		showStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	// Append findings to successful edit/write results. The result is never marked as an error:
	// the edit did succeed, the model just gets told what it broke. Pi drops `structuredContent`
	// when a handler returns `content` alone, so it is passed back through unchanged.
	pi.on("tool_result", async (event, ctx) => {
		if (!enabled || event.isError) return;
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const file = targetOf(event.input, ctx);
		if (!file) return;
		let outcome: CheckOutcome | undefined;
		try {
			outcome = await check(ctx, file);
		} catch (e) {
			notifyOnce(ctx, `error:${(e as Error).message}`, (e as Error).message);
			return;
		}
		if (!outcome) return;
		last = outcome;
		showStatus(ctx);
		const block = renderBlock(outcome.name, outcome.diagnostics, { cwd: ctx.cwd, maxLines: config.maxLines, platform: process.platform });
		if (!block) return;
		const content = [...event.content, { type: "text" as const, text: `\n${block}` }];
		return event.structuredContent === undefined ? { content } : { content, structuredContent: event.structuredContent };
	});

	// -- command ------------------------------------------------------------

	function describe(): string {
		const exts = Object.keys(config.checkers).sort().join(", ") || "(none)";
		const lines = [
			`Diagnostics: ${enabled ? "on" : "off"}`,
			`Config: ${configPath()}${existsSync(configPath()) ? "" : " (not found, using defaults)"}`,
			`Checked extensions: ${exts}`,
			`Timeout: ${config.timeoutMs} ms, debounce: ${config.debounceMs} ms, max lines: ${config.maxLines}`,
		];
		if (missing.size) lines.push(`Missing this session: ${[...missing].join(", ")}`);
		if (last) lines.push(`Last run: ${statusText(last.name, summarize(last.diagnostics))}`);
		return lines.join("\n");
	}

	pi.registerCommand("diagnostics", {
		description: "Post-edit diagnostics (tsc/pyright/go vet): /diagnostics [status|on|off|run <file>]",
		getArgumentCompletions: (prefix) => {
			const subs = ["status", "on", "off", "run"].filter((s) => s.startsWith(prefix));
			return subs.length ? subs.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const [sub = "status"] = trimmed.split(/\s+/);
			switch (sub) {
				case "status":
					ctx.ui.notify(describe(), "info");
					return;
				case "on":
					enabled = true;
					showStatus(ctx);
					ctx.ui.notify("diagnostics enabled.", "info");
					return;
				case "off":
					enabled = false;
					showStatus(ctx);
					ctx.ui.notify("diagnostics disabled for this session.", "info");
					return;
				case "run": {
					const arg = trimmed.slice(sub.length).trim();
					if (!arg) {
						ctx.ui.notify("Usage: /diagnostics run <file>", "warning");
						return;
					}
					const file = resolveTarget(arg, ctx.cwd, homedir(), process.platform);
					if (!existsSync(file)) {
						ctx.ui.notify(`diagnostics: no such file: ${file}`, "warning");
						return;
					}
					let outcome: CheckOutcome | undefined;
					try {
						outcome = await check(ctx, file);
					} catch (e) {
						ctx.ui.notify(`diagnostics: ${(e as Error).message}`, "error");
						return;
					}
					if (!outcome) {
						ctx.ui.notify(`diagnostics: no checker ran for ${file} (no checker for its extension, or its binary is missing).`, "info");
						return;
					}
					last = outcome;
					showStatus(ctx);
					const block = renderBlock(outcome.name, outcome.diagnostics, { cwd: ctx.cwd, maxLines: config.maxLines, platform: process.platform });
					ctx.ui.notify(block || `Diagnostics (${outcome.name}): no errors`, outcome.diagnostics.length ? "warning" : "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /diagnostics [status|on|off|run <file>]", "warning");
			}
		},
	});
}
