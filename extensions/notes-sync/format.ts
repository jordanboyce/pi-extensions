/**
 * Pure helpers for pi-notes-sync: config shape, file naming, tag sanitising and
 * Markdown rendering. No pi imports so it can be unit tested.
 */

import { join } from "node:path";

export type NoteKind = "note" | "decision" | "arch" | "todo";
export const NOTE_KINDS: readonly NoteKind[] = ["note", "decision", "arch", "todo"];

export interface JoplinConfig {
	/** Data API port (Joplin > Options > Web Clipper). Default 41184. */
	port?: number;
	/** Must be a loopback host. Default 127.0.0.1. */
	host?: string;
	/** Notebook (top-level folder) to file notes under. Default "Pi Notes". */
	notebook?: string;
	/** Name of the env var that holds the Data API token. Default JOPLIN_TOKEN. */
	tokenEnv?: string;
}

export interface NotesConfig {
	/** Obsidian vault root (or any folder a note app watches). */
	vault?: string;
	/** Sub-folder inside the vault. Default "Pi Notes". */
	folder?: string;
	/** `project`: one file per project. `daily`: one file per project per day. Default `project`. */
	layout?: "project" | "daily";
	/** Tags added to every entry. Default ["pi"]. */
	tags?: string[];
	/** Register the `save_note` tool so the model can log things when you ask it to. Default true. */
	modelTool?: boolean;
	/** Log the "Key Decisions" of every context compaction as a decision entry. Default false. */
	logCompaction?: boolean;
	joplin?: JoplinConfig;
}

/**
 * Bullet items under the `## Key Decisions` heading of a pi compaction summary, without the
 * list marker. Stops at the next `## ` heading. Returns [] when the section is missing or empty.
 */
export function extractCompactionDecisions(summary: string): string[] {
	const lines = summary.split(/\r?\n/);
	const start = lines.findIndex((l) => /^##\s+Key Decisions\s*$/i.test(l.trim()));
	if (start < 0) return [];
	const out: string[] = [];
	for (const line of lines.slice(start + 1)) {
		const t = line.trim();
		if (/^##\s/.test(t)) break;
		const item = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(t)?.[1]?.trim();
		if (item && !/^\[.*\]$/.test(item)) out.push(item); // skip the template's own "[Decision]" placeholder
	}
	return out;
}

export interface NoteEntry {
	kind: NoteKind;
	text: string;
	title?: string;
	project: string;
	branch?: string;
	date: Date;
}

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Safe on Windows, macOS and Linux (Obsidian vaults often sync across all three). */
export function sanitizeFileName(name: string): string {
	let s = name
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/-{2,}/g, "-")
		.trim()
		.replace(/[. ]+$/, "");
	if (!s || /^\.+$/.test(s)) s = "untitled";
	if (RESERVED_WINDOWS_NAMES.test(s)) s = `_${s}`;
	return s.slice(0, 100);
}

/** Obsidian tags: letters, digits, `_`, `-`, `/`; not purely numeric. */
export function sanitizeTag(raw: string): string {
	let s = raw
		.trim()
		.replace(/[^\p{L}\p{N}_\-/]+/gu, "-")
		.replace(/-{2,}/g, "-")
		.replace(/\/{2,}/g, "/")
		.replace(/^[-/]+|[-/]+$/g, "");
	if (!s) s = "untagged";
	if (/^\d+$/.test(s)) s = `n${s}`;
	return s;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const formatDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const formatTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function entryTags(entry: NoteEntry, baseTags: string[] = ["pi"]): string[] {
	const tags = [...baseTags.map(sanitizeTag), sanitizeTag(entry.kind), `project/${sanitizeTag(entry.project)}`];
	if (entry.branch) tags.push(`branch/${sanitizeTag(entry.branch)}`);
	return [...new Set(tags)];
}

/** Absolute path of the Markdown file an entry belongs in. */
export function notePath(dir: string, config: NotesConfig, entry: NoteEntry): string {
	const project = sanitizeFileName(entry.project);
	return config.layout === "daily"
		? join(dir, project, `${formatDate(entry.date)}.md`)
		: join(dir, `${project}.md`);
}

export function fileHeader(entry: NoteEntry, config: NotesConfig): string {
	const tags = [...(config.tags ?? ["pi"]).map(sanitizeTag), `project/${sanitizeTag(entry.project)}`];
	const daily = config.layout === "daily";
	return [
		"---",
		`project: ${JSON.stringify(entry.project)}`,
		...(daily ? [`date: ${formatDate(entry.date)}`] : []),
		`tags: [${[...new Set(tags)].join(", ")}]`,
		"---",
		"",
		daily ? `# ${entry.project} — ${formatDate(entry.date)}` : `# ${entry.project} — pi notes`,
		"",
	].join("\n");
}

/** Short one-line title, used in headings and as the Joplin note title. */
export function entryTitle(entry: NoteEntry): string {
	if (entry.title?.trim()) return entry.title.trim();
	const firstLine = entry.text.trim().split(/\r?\n/)[0] ?? "";
	return firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
}

/**
 * Body without a heading: shared by the Markdown file and Joplin.
 * A todo is a single Obsidian Tasks checkbox: project and branch live in its tags, and with
 * `withCreated` the line ends in Tasks' created-date field (`➕ YYYY-MM-DD`) so the plugin can
 * sort and filter by it. Nothing may follow that field, which is why there is no time of day.
 */
export function entryBody(entry: NoteEntry, baseTags?: string[], withCreated = false): string {
	const tagLine = entryTags(entry, baseTags).map((t) => `#${t}`).join(" ");
	if (entry.kind === "todo") {
		const [first = "", ...rest] = entry.text.trim().split(/\r?\n/);
		const continuation = rest.filter((l) => l.trim()).map((l) => `  ${l.trim()}`);
		const created = withCreated ? ` ➕ ${formatDate(entry.date)}` : "";
		return [`- [ ] ${first.trim()} ${tagLine}${created}`, ...continuation].join("\n");
	}
	const meta = `**Project:** ${entry.project}${entry.branch ? ` · **Branch:** \`${entry.branch}\`` : ""}`;
	return [meta, "", entry.text.trim(), "", tagLine].join("\n");
}

export function formatEntry(entry: NoteEntry, config: NotesConfig, withDate: boolean): string {
	if (entry.kind === "todo") return `\n${entryBody(entry, config.tags, true)}\n`;
	const when = withDate ? `${formatDate(entry.date)} ${formatTime(entry.date)}` : formatTime(entry.date);
	const body = entryBody(entry, config.tags);
	const title = entry.title?.trim();
	return `\n## ${when} · ${entry.kind}${title ? ` — ${title}` : ""}\n\n${body}\n`;
}

export function projectNameFromRemote(url: string): string {
	const cleaned = url.trim().replace(/\.git$/i, "").replace(/[/\\]+$/, "");
	const last = cleaned.split(/[/:\\]/).filter(Boolean).pop();
	return last ?? "";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return !!v && typeof v === "object" && !Array.isArray(v);
}

export function validateConfig(raw: unknown): { config?: NotesConfig; error?: string } {
	if (!isPlainObject(raw)) return { error: "config must be a JSON object" };
	const c = raw;
	for (const key of ["vault", "folder"] as const) {
		if (c[key] !== undefined && (typeof c[key] !== "string" || !c[key])) return { error: `"${key}" must be a non-empty string` };
	}
	if (c.layout !== undefined && c.layout !== "project" && c.layout !== "daily") {
		return { error: '"layout" must be "project" or "daily"' };
	}
	if (c.tags !== undefined && (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== "string"))) {
		return { error: '"tags" must be an array of strings' };
	}
	for (const key of ["modelTool", "logCompaction"] as const) {
		if (c[key] !== undefined && typeof c[key] !== "boolean") return { error: `"${key}" must be true or false` };
	}
	if (c.joplin !== undefined) {
		if (!isPlainObject(c.joplin)) return { error: '"joplin" must be an object' };
		const j = c.joplin;
		if (j.host !== undefined && (typeof j.host !== "string" || !/^(127\.0\.0\.1|localhost|\[?::1\]?)$/i.test(j.host))) {
			return { error: "joplin.host must be a loopback address (127.0.0.1, localhost or ::1)" };
		}
		if (j.port !== undefined && (!Number.isInteger(j.port) || (j.port as number) < 1 || (j.port as number) > 65535)) {
			return { error: "joplin.port must be an integer between 1 and 65535" };
		}
		for (const key of ["notebook", "tokenEnv"] as const) {
			if (j[key] !== undefined && (typeof j[key] !== "string" || !j[key])) return { error: `joplin.${key} must be a non-empty string` };
		}
	}
	return { config: c as NotesConfig };
}
