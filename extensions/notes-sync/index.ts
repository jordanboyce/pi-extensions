/**
 * pi-notes-sync
 *
 * Log decisions, architecture notes and todos from a pi session straight into a
 * folder an Obsidian vault watches (or into Joplin via its local Data API),
 * tagged with the current project and git branch.
 *
 *   /note <text>      free-form note
 *   /decision <text>  a decision and its reasoning
 *   /arch <text>      architecture note
 *   /todo <text>      Obsidian-Tasks style checkbox
 *   /notes [path|open|recent]
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	entryBody,
	entryTags,
	entryTitle,
	fileHeader,
	formatEntry,
	NOTE_KINDS,
	notePath,
	projectNameFromRemote,
	validateConfig,
	type NoteEntry,
	type NoteKind,
	type NotesConfig,
} from "./format.ts";
import { sendToJoplin } from "./joplin.ts";
import { appendToNote, recentEntries } from "./store.ts";

function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

interface Loaded {
	config: NotesConfig;
	/** Directory entries are written into. */
	dir: string;
	/** True when nothing was configured and we fell back to ~/.pi/agent/notes. */
	isFallback: boolean;
}

async function loadConfig(): Promise<Loaded> {
	const file = process.env.PI_NOTES_CONFIG || join(agentDir(), "notes-sync.json");
	let config: NotesConfig = {};
	try {
		const parsed = validateConfig(JSON.parse(await readFile(file, "utf8")));
		if (parsed.error) throw new Error(`${file}: ${parsed.error}`);
		config = parsed.config ?? {};
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
	}
	const override = process.env.PI_NOTES_DIR;
	if (override) return { config, dir: override, isFallback: false };
	if (config.vault) return { config, dir: join(config.vault, config.folder ?? "Pi Notes"), isFallback: false };
	return { config, dir: join(agentDir(), "notes"), isFallback: true };
}

export default async function notesSync(pi: ExtensionAPI) {
	let announcedFallback = false;

	async function git(cwd: string, args: string[]): Promise<string | undefined> {
		try {
			const r = await pi.exec("git", args, { cwd, timeout: 5000 });
			return r.code === 0 ? r.stdout.trim() || undefined : undefined;
		} catch {
			return undefined;
		}
	}

	async function context(cwd: string): Promise<{ project: string; branch?: string }> {
		const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
		if (!root) return { project: basename(cwd) };
		// Prefer `origin`; a repo whose only remote is named differently (e.g. a fork setup) still gets its remote name.
		const names = ((await git(root, ["remote"])) ?? "").split(/\r?\n/).filter(Boolean);
		const primary = names.includes("origin") ? "origin" : names[0];
		const remote = primary ? await git(root, ["remote", "get-url", primary]) : undefined;
		const project = (remote && projectNameFromRemote(remote)) || basename(root);
		let branch = await git(root, ["branch", "--show-current"]);
		if (!branch) {
			const sha = await git(root, ["rev-parse", "--short", "HEAD"]);
			branch = sha ? `detached-${sha}` : undefined;
		}
		return { project, branch };
	}

	interface SaveResult {
		path: string;
		warnings: string[];
		fallback: boolean;
	}

	async function save(cwd: string, kind: NoteKind, text: string, title?: string): Promise<SaveResult> {
		const loaded = await loadConfig();
		const { project, branch } = await context(cwd);
		const entry: NoteEntry = { kind, text, title, project, branch, date: new Date() };
		const path = notePath(loaded.dir, loaded.config, entry);
		const daily = loaded.config.layout === "daily";
		await appendToNote(path, fileHeader(entry, loaded.config), formatEntry(entry, loaded.config, !daily));

		const warnings: string[] = [];
		if (loaded.config.joplin) {
			const tokenEnv = loaded.config.joplin.tokenEnv ?? "JOPLIN_TOKEN";
			const token = process.env[tokenEnv];
			if (!token) {
				warnings.push(`Joplin skipped: ${tokenEnv} is not set`);
			} else {
				try {
					await sendToJoplin(loaded.config.joplin, token, {
						title: `[${kind}] ${entryTitle(entry)}`,
						body: entryBody(entry, loaded.config.tags),
						tags: entryTags(entry, loaded.config.tags),
					});
				} catch (e) {
					warnings.push(`Joplin failed (file was still saved): ${(e as Error).message}`);
				}
			}
		}
		return { path, warnings, fallback: loaded.isFallback };
	}

	async function run(ctx: ExtensionContext, kind: NoteKind, args: string): Promise<void> {
		let text = args.trim();
		if (!text && ctx.hasUI) text = ((await ctx.ui.input(`Log ${kind}`, "what to record")) ?? "").trim();
		if (!text) {
			ctx.ui.notify(`Usage: /${kind} <text>`, "warning");
			return;
		}
		try {
			const r = await save(ctx.cwd, kind, text);
			const lines = [`Saved ${kind} → ${r.path}`, ...r.warnings];
			if (r.fallback && !announcedFallback) {
				announcedFallback = true;
				lines.push(
					`No vault configured, so notes go to ${dirname(r.path)}. ` +
						`Set "vault" in ${join(agentDir(), "notes-sync.json")} to write into Obsidian.`,
				);
			}
			ctx.ui.notify(lines.join("\n"), r.warnings.length ? "warning" : "info");
		} catch (e) {
			ctx.ui.notify(`notes-sync: ${(e as Error).message}`, "error");
		}
	}

	const labels: Record<NoteKind, string> = {
		note: "Log a note to your vault",
		decision: "Log a decision to your vault",
		arch: "Log an architecture note to your vault",
		todo: "Log a todo to your vault",
	};
	for (const kind of NOTE_KINDS) {
		pi.registerCommand(kind, {
			description: `${labels[kind]} (tagged with project and branch)`,
			handler: async (args, ctx) => run(ctx, kind, args),
		});
	}

	pi.registerCommand("notes", {
		description: "Notes sync: /notes [path|open|recent]",
		getArgumentCompletions: (prefix) => {
			const subs = ["path", "open", "recent"].filter((s) => s.startsWith(prefix));
			return subs.length ? subs.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const sub = args.trim() || "path";
			try {
				const loaded = await loadConfig();
				const { project, branch } = await context(ctx.cwd);
				const probe: NoteEntry = { kind: "note", text: "", project, branch, date: new Date() };
				const path = notePath(loaded.dir, loaded.config, probe);
				if (sub === "path") {
					ctx.ui.notify(`${path}\n(project: ${project}${branch ? `, branch: ${branch}` : ""})`, "info");
				} else if (sub === "recent") {
					const rows = await recentEntries(path, 8);
					ctx.ui.notify(rows.length ? rows.join("\n") : `No entries yet in ${path}`, "info");
				} else if (sub === "open") {
					// Inside a vault, hand the file to Obsidian itself (it registers the obsidian:// scheme);
					// otherwise the OS default app for .md gets it. The file may not exist yet: create it so the
					// target opens instead of erroring.
					await appendToNote(path, fileHeader(probe, loaded.config), "");
					const target = loaded.config.vault ? `obsidian://open?path=${encodeURIComponent(path)}` : path;
					const [cmd, argv]: [string, string[]] =
						process.platform === "win32" ? ["explorer.exe", [target]] : process.platform === "darwin" ? ["open", [target]] : ["xdg-open", [target]];
					await pi.exec(cmd, argv, { timeout: 5000 }).catch(() => undefined); // explorer.exe exits 1 on success
					ctx.ui.notify(`Opening ${path}${loaded.config.vault ? " in Obsidian" : ""}`, "info");
				} else {
					ctx.ui.notify("Usage: /notes [path|open|recent]", "warning");
				}
			} catch (e) {
				ctx.ui.notify(`notes-sync: ${(e as Error).message}`, "error");
			}
		},
	});

	// Optional model-callable tool, gated by config. Pi awaits an async factory, so registering here is safe.
	let toolEnabled = true;
	try {
		toolEnabled = (await loadConfig()).config.modelTool !== false;
	} catch {
		/* a broken config is reported when a command runs */
	}
	if (toolEnabled) {
		pi.registerTool({
			name: "save_note",
			label: "Save note",
			description:
				"Append a note, decision, architecture note or todo to the user's notes vault, tagged with the current project and git branch. " +
				"Only use when the user explicitly asks to record or log something.",
			promptSnippet: "save_note: log a decision/todo/note to the user's notes vault (only when asked)",
			promptGuidelines: ["Call save_note only when the user explicitly asks to log or record something; never on your own initiative."],
			parameters: Type.Object({
				kind: StringEnum(["note", "decision", "arch", "todo"] as const, { description: "Type of entry" }),
				text: Type.String({ description: "The content to record. Be concise but self-contained." }),
				title: Type.Optional(Type.String({ description: "Optional short title" })),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const r = await save(ctx.cwd, params.kind as NoteKind, params.text, params.title);
				const note = r.warnings.length ? ` (${r.warnings.join("; ")})` : "";
				return {
					content: [{ type: "text", text: `Saved ${params.kind} to ${basename(r.path)}${note}` }],
					details: { path: r.path },
				};
			},
		});
	}
}
