/**
 * Pure logic for pi-screenshots: finding image paths in a prompt, sniffing image bytes, rewriting
 * the prompt text, locating screenshot folders and validating the config. No pi imports, so it
 * runs under plain `node --test`.
 */

import { posix, win32 } from "node:path";

export type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ScreenshotsConfig {
	/** Attach image paths found in prompts. */
	autoAttach: boolean;
	/** Most images attached to one prompt; extra paths stay as text. */
	maxImages: number;
	/** Files larger than this stay as text. */
	maxBytes: number;
	/** Folders `/screenshot` looks in; replaces the platform defaults when set. */
	screenshotDirs?: string[];
	/** `/screenshot` warns when the newest capture is older than this. */
	staleAfterMinutes: number;
}

export const DEFAULTS: ScreenshotsConfig = {
	autoAttach: true,
	maxImages: 8,
	maxBytes: 25 * 1024 * 1024,
	staleAfterMinutes: 15,
};

const CONFIG_KEYS = new Set(["autoAttach", "maxImages", "maxBytes", "screenshotDirs", "staleAfterMinutes"]);

export const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

function pathFor(platform: string) {
	return platform === "win32" ? win32 : posix;
}

/** Identifies PNG, JPEG, GIF and WebP from their magic bytes; anything else is null. */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
	const b = bytes;
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
	if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
	return null;
}

export function extensionForMime(mime: ImageMime): string {
	return mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
}

export function expandHome(p: string, home: string, platform: string): string {
	if (p === "~") return home;
	if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return pathFor(platform).join(home, p.slice(2));
	return p;
}

export interface FoundPath {
	/** Offsets into the prompt of the text to replace (includes surrounding quotes or a leading `@`). */
	start: number;
	end: number;
	/** The path as written, without quotes, `@` or shell escapes. */
	written: string;
	/** Absolute path of the file. */
	path: string;
}

export interface FindOptions {
	cwd: string;
	home: string;
	platform: string;
	isFile: (absolutePath: string) => boolean;
}

// An image extension ending a token: followed by the end of the line, whitespace, a closing quote
// or bracket, or sentence punctuation.
const EXT_END = /\.(?:png|jpe?g|gif|webp)(?=$|[\s"'`)\]>,;!?]|[.:](?:\s|$))/gi;
const TOKEN_START = /[\s"'`(<[@]/;
const QUOTES = new Set(['"', "'", "`"]);
const MAX_PATH_LENGTH = 1024;

/**
 * Finds paths to existing image files in `text`. Paths may be absolute, relative to `cwd`,
 * `~`-prefixed, quoted, `@`-prefixed, or unquoted with spaces in them (as pi's Alt+V paste and
 * terminal drag-and-drop insert them). POSIX shell escapes (`Screen\ Shot.png`) are understood
 * off Windows. For each image extension the longest candidate that names an existing file wins,
 * and a path is matched at most once per occurrence.
 */
export function findImagePaths(text: string, opts: FindOptions): FoundPath[] {
	const P = pathFor(opts.platform);
	const found: FoundPath[] = [];
	let lineStart = 0;
	for (const line of text.split("\n")) {
		let floor = 0;
		EXT_END.lastIndex = 0;
		for (let m = EXT_END.exec(line); m; m = EXT_END.exec(line)) {
			const extEnd = m.index + m[0].length;
			const hit = longestExisting(line, floor, m.index, extEnd, opts, P);
			if (!hit) continue;
			let { start, end } = hit;
			const before = line[start - 1];
			if (before !== undefined && QUOTES.has(before) && line[end] === before) {
				start--;
				end++;
			} else if (before === "@" && (start === 1 || /\s/.test(line[start - 2] ?? ""))) {
				start--;
			}
			found.push({ start: lineStart + start, end: lineStart + end, written: hit.written, path: hit.path });
			floor = end;
			EXT_END.lastIndex = Math.max(EXT_END.lastIndex, end);
		}
		lineStart += line.length + 1;
	}
	return found;
}

function longestExisting(
	line: string,
	floor: number,
	extStart: number,
	extEnd: number,
	opts: FindOptions,
	P: typeof posix,
): { start: number; end: number; written: string; path: string } | undefined {
	for (let s = Math.max(floor, extEnd - MAX_PATH_LENGTH); s < extStart; s++) {
		if (s > 0 && !TOKEN_START.test(line[s - 1]!)) continue;
		if (TOKEN_START.test(line[s]!)) continue;
		const raw = line.slice(s, extEnd);
		if (raw.includes("://")) continue;
		const variants = opts.platform === "win32" || !raw.includes("\\") ? [raw] : [raw.replace(/\\(.)/g, "$1"), raw];
		for (const written of variants) {
			const abs = P.resolve(opts.cwd, expandHome(written, opts.home, opts.platform));
			if (opts.isFile(abs)) return { start: s, end: extEnd, written, path: abs };
		}
	}
	return undefined;
}

/** pi's Alt+V paste and `/paste-image` save to `<tmp>/pi-clipboard-<uuid>.<ext>`; those names mean nothing to the model. */
export function isClipboardTemp(absolutePath: string, tmpDir: string, platform: string): boolean {
	const P = pathFor(platform);
	const sameDir = platform === "win32" ? P.dirname(absolutePath).toLowerCase() === P.resolve(tmpDir).toLowerCase() : P.dirname(absolutePath) === P.resolve(tmpDir);
	return sameDir && /^pi-clipboard-[0-9a-f-]+\.(?:png|jpe?g|gif|webp)$/i.test(P.basename(absolutePath));
}

export interface Replacement {
	start: number;
	end: number;
	label: string;
}

/** Applies non-overlapping replacements (in any order) to `text`. */
export function applyReplacements(text: string, replacements: Replacement[]): string {
	let out = "";
	let at = 0;
	for (const r of [...replacements].sort((a, b) => a.start - b.start)) {
		out += text.slice(at, r.start) + r.label;
		at = r.end;
	}
	return out + text.slice(at);
}

export function imageLabel(n: number, written: string | undefined): string {
	return written ? `[image ${n}: ${written}]` : `[image ${n}]`;
}

/** Quotes a path for the editor when it has whitespace, so the prompt reads unambiguously. */
export function quoteForPrompt(p: string): string {
	return /\s/.test(p) ? `"${p}"` : p;
}

export interface ScreenshotSource {
	dir: string;
	/** Only files whose name matches; folders shared with other images (Desktop, Pictures) need one. */
	namePattern?: RegExp;
}

const SCREENSHOT_NAME = /^(?:screenshot|screen shot|cleanshot)/i;

/** Where the OS screenshot tools save by default. Win+Shift+S / Snipping Tool saves to Pictures\Screenshots. */
export function defaultScreenshotSources(platform: string, home: string, env: Record<string, string | undefined>): ScreenshotSource[] {
	const P = pathFor(platform);
	if (platform === "win32") {
		const roots = [env.USERPROFILE || home, env.OneDrive, env.OneDriveConsumer, env.OneDriveCommercial].filter((r): r is string => !!r);
		const dirs = roots.map((r) => P.join(r, "Pictures", "Screenshots"));
		return [...new Set(dirs.map((d) => d.toLowerCase()))].map((k) => ({ dir: dirs.find((d) => d.toLowerCase() === k)! }));
	}
	if (platform === "darwin") {
		return [{ dir: P.join(home, "Desktop"), namePattern: SCREENSHOT_NAME }, { dir: P.join(home, "Pictures", "Screenshots") }];
	}
	const pictures = env.XDG_PICTURES_DIR ? expandHome(env.XDG_PICTURES_DIR.replace(/^\$HOME/, "~"), home, platform) : P.join(home, "Pictures");
	return [{ dir: P.join(pictures, "Screenshots") }, { dir: pictures, namePattern: SCREENSHOT_NAME }];
}

export interface FileEntry {
	path: string;
	name: string;
	mtimeMs: number;
}

/** The newest `count` image files across the given listings, newest first. */
export function newestImages(listings: { source: ScreenshotSource; entries: FileEntry[] }[], count: number): FileEntry[] {
	const all: FileEntry[] = [];
	const seen = new Set<string>();
	for (const { source, entries } of listings) {
		for (const e of entries) {
			const lower = e.name.toLowerCase();
			if (!IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) continue;
			if (source.namePattern && !source.namePattern.test(e.name)) continue;
			if (seen.has(e.path)) continue;
			seen.add(e.path);
			all.push(e);
		}
	}
	return all.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, count);
}

export function formatAge(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h} h ago`;
	return `${Math.round(h / 24)} days ago`;
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown, name: string): { value?: number; error?: string } {
	if (v === undefined) return {};
	if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) return { error: `${name} must be a positive integer` };
	return { value: v };
}

export function validateConfig(raw: unknown): { config?: ScreenshotsConfig; error?: string } {
	if (!isRecord(raw)) return { error: "config must be a JSON object" };
	for (const k of Object.keys(raw)) if (!CONFIG_KEYS.has(k)) return { error: `unknown key "${k}"` };
	if (raw.autoAttach !== undefined && typeof raw.autoAttach !== "boolean") return { error: `"autoAttach" must be true or false` };
	const nums: Partial<Record<"maxImages" | "maxBytes" | "staleAfterMinutes", number>> = {};
	for (const k of ["maxImages", "maxBytes", "staleAfterMinutes"] as const) {
		const r = positiveInt(raw[k], `"${k}"`);
		if (r.error) return { error: r.error };
		if (r.value !== undefined) nums[k] = r.value;
	}
	let screenshotDirs: string[] | undefined;
	if (raw.screenshotDirs !== undefined) {
		if (!Array.isArray(raw.screenshotDirs) || !raw.screenshotDirs.length || raw.screenshotDirs.some((d) => typeof d !== "string" || !d.trim())) {
			return { error: `"screenshotDirs" must be a non-empty array of folder paths` };
		}
		screenshotDirs = raw.screenshotDirs as string[];
	}
	return {
		config: {
			autoAttach: raw.autoAttach !== false,
			maxImages: nums.maxImages ?? DEFAULTS.maxImages,
			maxBytes: nums.maxBytes ?? DEFAULTS.maxBytes,
			staleAfterMinutes: nums.staleAfterMinutes ?? DEFAULTS.staleAfterMinutes,
			...(screenshotDirs ? { screenshotDirs } : {}),
		},
	};
}
