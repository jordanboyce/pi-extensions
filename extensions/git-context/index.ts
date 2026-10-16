/**
 * pi-git-context
 *
 * Injects a compact picture of the repository (branch, recent commits, commits
 * on this branch, uncommitted changes with diff stats) into pi's system prompt
 * so you don't have to explain the repo's state at the start of every session.
 *
 *   /git-context [show|refresh|on|off]
 *
 * Config (optional): ~/.pi/agent/git-context.json  -  see snapshot.ts GitContextConfig.
 * Disable per run with PI_GIT_CONTEXT=off.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { collectSnapshot, normalizeConfig, renderSnapshot, statusSummary, type Git, type GitContextConfig } from "./snapshot.ts";

const STATUS_KEY = "git-context";
const SECTION = "git_context";

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "git-context.json");
}

/** A missing file means defaults; a broken one is reported (and defaults are used) rather than silently ignored. */
async function loadConfig(): Promise<{ config: GitContextConfig; error?: string }> {
	let text: string;
	try {
		text = await readFile(configPath(), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: {} };
		return { config: {}, error: `could not read ${configPath()}: ${(e as Error).message}` };
	}
	try {
		const r = normalizeConfig(JSON.parse(text));
		return r.error ? { config: {}, error: `${configPath()}: ${r.error}` } : { config: r.config };
	} catch (e) {
		return { config: {}, error: `${configPath()} is not valid JSON: ${(e as Error).message}` };
	}
}

export default function gitContext(pi: ExtensionAPI) {
	let config: GitContextConfig = {};
	let enabled = true;
	let rendered: string | undefined;

	function runner(cwd: string): Git {
		return async (args) => {
			const r = await pi.exec("git", ["--no-pager", "--no-optional-locks", "-c", "core.quotepath=false", ...args], { cwd, timeout: 8000 });
			return { stdout: r.stdout, code: r.code };
		};
	}

	/** Collect + render. Returns the text, or undefined outside a git repository. */
	async function refresh(ctx: ExtensionContext): Promise<string | undefined> {
		try {
			const snap = await collectSnapshot({ git: runner(ctx.cwd), exists: existsSync }, config);
			if (!snap) {
				rendered = undefined;
				if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
				return undefined;
			}
			rendered = renderSnapshot(snap, config);
			if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", statusSummary(snap)));
			return rendered;
		} catch (e) {
			rendered = undefined;
			ctx.ui.notify(`git-context: ${(e as Error).message}`, "warning");
			return undefined;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig();
		config = loaded.config;
		if (loaded.error) ctx.ui.notify(`git-context: ${loaded.error} (using defaults)`, "warning");
		enabled = config.enabled !== false && process.env.PI_GIT_CONTEXT?.toLowerCase() !== "off";
		if (!enabled) return;
		await refresh(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) {
			delete event.systemPromptOptions.sections[SECTION];
			return;
		}
		if (config.mode === "live") await refresh(ctx);
		if (rendered) event.systemPromptOptions.sections[SECTION] = rendered;
		else delete event.systemPromptOptions.sections[SECTION];
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.registerCommand("git-context", {
		description: "Git context injection: /git-context [show|refresh|on|off]",
		getArgumentCompletions: (prefix) => {
			const subs = ["show", "refresh", "on", "off"].filter((s) => s.startsWith(prefix));
			return subs.length ? subs.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			switch (args.trim() || "show") {
				case "show":
					ctx.ui.notify(enabled ? (rendered ?? "No git repository here (nothing injected).") : "git-context is off for this session.", "info");
					return;
				case "refresh": {
					enabled = true;
					const text = await refresh(ctx);
					ctx.ui.notify(text ? `Refreshed. Injected on the next prompt:\n\n${text}` : "No git repository here (nothing injected).", "info");
					return;
				}
				case "on":
					enabled = true;
					await refresh(ctx);
					ctx.ui.notify("git-context enabled.", "info");
					return;
				case "off":
					enabled = false;
					rendered = undefined;
					if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
					ctx.ui.notify("git-context disabled for this session (the prompt section is removed on the next prompt).", "info");
					return;
				default:
					ctx.ui.notify("Usage: /git-context [show|refresh|on|off]", "warning");
			}
		},
	});
}
