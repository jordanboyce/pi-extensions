/**
 * Minimal Joplin Data API client (https://joplinapp.org/api/references/rest_api/).
 * Joplin has no watched-folder import, so the local Data API is the way to
 * get notes in "instantly". Loopback only; token comes from an env var.
 */

import type { JoplinConfig } from "./format.ts";

type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
}>;

interface Page<T> {
	items: T[];
	has_more?: boolean;
}

interface Item {
	id: string;
	title: string;
	parent_id?: string;
}

/** `${base}|${notebook}` -> folder id, and `${base}|tag:${title}` -> tag id. Joplin ids are stable for the app's lifetime. */
const folderCache = new Map<string, string>();
const tagCache = new Map<string, string>();

export interface JoplinNote {
	title: string;
	body: string;
	tags: string[];
}

export async function sendToJoplin(
	cfg: JoplinConfig,
	token: string,
	note: JoplinNote,
	fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
	const host = cfg.host ?? "127.0.0.1";
	const base = `http://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${cfg.port ?? 41184}`;
	const q = `token=${encodeURIComponent(token)}`;

	async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
		const sep = path.includes("?") ? "&" : "?";
		const res = await fetchImpl(`${base}${path}${sep}${q}`, {
			method,
			headers: body === undefined ? undefined : { "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!res.ok) throw new Error(`Joplin ${method} ${path.split("?")[0]} -> HTTP ${res.status}`);
		return (await res.json()) as T;
	}

	async function listAll(path: string): Promise<Item[]> {
		const out: Item[] = [];
		for (let page = 1; page < 50; page++) {
			const sep = path.includes("?") ? "&" : "?";
			const r = await call<Page<Item>>("GET", `${path}${sep}page=${page}&fields=id,title,parent_id`);
			out.push(...r.items);
			if (!r.has_more) break;
		}
		return out;
	}

	const notebook = cfg.notebook ?? "Pi Notes";
	const cacheKey = `${base}|${notebook}`;
	let folderId = folderCache.get(cacheKey);
	if (!folderId) {
		const existing = (await listAll("/folders")).find((f) => f.title === notebook && !f.parent_id);
		folderId = existing?.id ?? (await call<Item>("POST", "/folders", { title: notebook })).id;
		folderCache.set(cacheKey, folderId);
	}

	const created = await call<Item>("POST", "/notes", { title: note.title, body: note.body, parent_id: folderId });

	for (const raw of note.tags) {
		const tag = raw.toLowerCase(); // Joplin lower-cases tag titles
		const tagKey = `${base}|tag:${tag}`;
		let tagId = tagCache.get(tagKey);
		if (!tagId) {
			const found = await call<Page<Item>>("GET", `/search?query=${encodeURIComponent(tag)}&type=tag&fields=id,title`);
			tagId = found.items.find((t) => t.title === tag)?.id ?? (await call<Item>("POST", "/tags", { title: tag })).id;
			tagCache.set(tagKey, tagId);
		}
		await call("POST", `/tags/${tagId}/notes`, { id: created.id });
	}
	return created.id;
}

export function clearJoplinCache(): void {
	folderCache.clear();
	tagCache.clear();
}
