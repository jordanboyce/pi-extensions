/**
 * pi-screenshots
 *
 * Gets screenshots into the conversation as images the model sees directly:
 *
 *   - Image paths in a prompt (pasted with Alt+V / Ctrl+V, dragged into the terminal, typed, or
 *     inserted by the commands below) are read and attached as images when the prompt is sent,
 *     instead of reaching the model as a path it has to `read`.
 *   - /screenshot [n]   puts the newest n screenshots (Win+Shift+S, Cmd+Shift+4, ...) in the prompt.
 *   - /paste-image      puts the clipboard image in the prompt, for terminals that swallow Alt+V.
 *
 * Config (optional): ~/.pi/agent/screenshots.json  -  see attach.ts ScreenshotsConfig.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { convertToPng, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import {
	applyReplacements,
	DEFAULTS,
	defaultScreenshotSources,
	expandHome,
	extensionForMime,
	type FileEntry,
	findImagePaths,
	formatAge,
	formatBytes,
	type ImageMime,
	imageLabel,
	isClipboardTemp,
	newestImages,
	quoteForPrompt,
	type Replacement,
	type ScreenshotSource,
	type ScreenshotsConfig,
	sniffImageMime,
	validateConfig,
} from "./attach.ts";

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "screenshots.json");
}

/** A missing file means defaults; a broken one is reported (and defaults are used) rather than silently ignored. */
async function loadConfig(): Promise<{ config: ScreenshotsConfig; error?: string }> {
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

type Loaded = { data: string; mimeType: ImageMime } | { error: string };

async function loadImage(path: string, maxBytes: number): Promise<Loaded> {
	try {
		const { size } = await stat(path);
		if (size > maxBytes) return { error: `${formatBytes(size)} is over the ${formatBytes(maxBytes)} limit` };
		const bytes = await readFile(path);
		const mimeType = sniffImageMime(bytes);
		if (!mimeType) return { error: "not a PNG, JPEG, GIF or WebP file" };
		return { data: bytes.toString("base64"), mimeType };
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/** Windows' clipboard through PowerShell; covers formats (DIB from some apps) the native helper misses. */
function readWindowsClipboardImage(): Promise<Uint8Array | null> {
	const file = join(tmpdir(), `pi-screenshots-${randomUUID()}.png`);
	const script = [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		`if ($img) { $img.Save('${file.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png); 'ok' } else { 'empty' }`,
	].join("; ");
	return new Promise((done) => {
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], { timeout: 10_000, windowsHide: true }, async (err, stdout) => {
			try {
				done(!err && stdout.trim() === "ok" ? new Uint8Array(await readFile(file)) : null);
			} catch {
				done(null);
			} finally {
				await rm(file, { force: true });
			}
		});
	});
}

async function readClipboardImage(): Promise<Uint8Array | null> {
	try {
		const image = await tui.getNativeClipboard?.()?.getImage();
		if (image?.length) return image;
	} catch {
		// Fall through to the platform fallback.
	}
	return process.platform === "win32" ? readWindowsClipboardImage() : null;
}

async function listSource(source: ScreenshotSource): Promise<{ source: ScreenshotSource; entries: FileEntry[] }> {
	let names: string[];
	try {
		names = (await readdir(source.dir, { withFileTypes: true })).filter((d) => d.isFile()).map((d) => d.name);
	} catch {
		return { source, entries: [] };
	}
	const candidates = names.filter((n) => /\.(?:png|jpe?g|gif|webp)$/i.test(n) && (!source.namePattern || source.namePattern.test(n)));
	const entries = await Promise.all(
		candidates.map(async (name) => {
			const path = join(source.dir, name);
			try {
				return { path, name, mtimeMs: (await stat(path)).mtimeMs };
			} catch {
				return undefined;
			}
		}),
	);
	return { source, entries: entries.filter((e): e is FileEntry => !!e) };
}

/** Appends paths to whatever is already in the editor, separated by a space. */
function insertIntoEditor(ctx: ExtensionContext, paths: string[]): void {
	const current = ctx.ui.getEditorText();
	const joined = paths.map(quoteForPrompt).join(" ");
	ctx.ui.setEditorText(!current ? `${joined} ` : `${current}${/\s$/.test(current) ? "" : " "}${joined} `);
}

export default function screenshots(pi: ExtensionAPI) {
	let config: ScreenshotsConfig = DEFAULTS;
	const noticed = new Set<string>();

	function notifyOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (noticed.has(key) || !ctx.hasUI) return;
		noticed.add(key);
		ctx.ui.notify(`screenshots: ${message}`, "warning");
	}

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig();
		config = loaded.config;
		if (loaded.error && ctx.hasUI) ctx.ui.notify(`screenshots: ${loaded.error} (using defaults)`, "warning");
	});

	// Replace image paths in the prompt with "[image N: path]" and attach the files. Pi resizes
	// attached images to the model's limits afterwards, as it does for its own attachments.
	pi.on("input", async (event, ctx) => {
		if (!config.autoAttach || event.source === "extension") return { action: "continue" };
		const text = event.text;
		if (text.startsWith("/") || text.startsWith("!")) return { action: "continue" };
		const platform = process.platform;
		const found = findImagePaths(text, { cwd: ctx.cwd, home: homedir(), platform, isFile });
		if (!found.length) return { action: "continue" };
		if (ctx.model && !ctx.model.input.includes("image")) {
			notifyOnce(ctx, `model:${ctx.model.id}`, `${ctx.model.id} does not accept images; image paths were sent as text.`);
			return { action: "continue" };
		}

		const images = [...(event.images ?? [])];
		const added = new Map<string, number>();
		const replacements: Replacement[] = [];
		const skipped: string[] = [];
		for (const f of found) {
			const key = platform === "win32" ? f.path.toLowerCase() : f.path;
			let n = added.get(key);
			if (n === undefined) {
				if (added.size >= config.maxImages) {
					skipped.push(`${basename(f.path)}: more than ${config.maxImages} images`);
					continue;
				}
				const loaded = await loadImage(f.path, config.maxBytes);
				if ("error" in loaded) {
					skipped.push(`${basename(f.path)}: ${loaded.error}`);
					continue;
				}
				images.push({ type: "image", data: loaded.data, mimeType: loaded.mimeType });
				n = images.length;
				added.set(key, n);
			}
			const written = isClipboardTemp(f.path, tmpdir(), platform) ? undefined : f.written;
			replacements.push({ start: f.start, end: f.end, label: imageLabel(n, written) });
		}
		if (skipped.length && ctx.hasUI) ctx.ui.notify(`screenshots: left as text: ${skipped.join("; ")}`, "warning");
		if (!replacements.length) return { action: "continue" };
		return { action: "transform", text: applyReplacements(text, replacements), images };
	});

	pi.registerCommand("screenshot", {
		description: "Put your newest screenshot(s) in the prompt: /screenshot [count]",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) return;
			const arg = args.trim();
			const count = arg ? Number(arg) : 1;
			if (!Number.isInteger(count) || count < 1 || count > config.maxImages) {
				ctx.ui.notify(`Usage: /screenshot [count]  (count 1-${config.maxImages})`, "warning");
				return;
			}
			const home = homedir();
			const sources: ScreenshotSource[] = config.screenshotDirs
				? config.screenshotDirs.map((d) => ({ dir: resolve(ctx.cwd, expandHome(d, home, process.platform)) }))
				: defaultScreenshotSources(process.platform, home, process.env);
			const newest = newestImages(await Promise.all(sources.map(listSource)), count);
			if (!newest.length) {
				ctx.ui.notify(
					`screenshots: no screenshots found in ${sources.map((s) => s.dir).join(", ")}. Set "screenshotDirs" in ${configPath()} if yours are saved elsewhere.`,
					"warning",
				);
				return;
			}
			insertIntoEditor(ctx, newest.map((e) => e.path));
			const age = Date.now() - newest[0]!.mtimeMs;
			const what = newest.length === 1 ? newest[0]!.name : `${newest.length} screenshots`;
			const stale = age > config.staleAfterMinutes * 60_000;
			ctx.ui.notify(
				`Added ${what} (${newest.length === 1 ? "taken" : "newest taken"} ${formatAge(age)}). ${stale ? "Check it is the one you meant; it" : "It"} is attached when you send.`,
				stale ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("paste-image", {
		description: "Put the clipboard image in the prompt (same as Alt+V/Ctrl+V, for terminals that intercept it)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			let bytes = await readClipboardImage();
			if (!bytes) {
				ctx.ui.notify("screenshots: the clipboard has no image.", "warning");
				return;
			}
			let mime = sniffImageMime(bytes);
			if (!mime) {
				const png = await convertToPng(Buffer.from(bytes).toString("base64"), "image/bmp");
				if (!png) {
					ctx.ui.notify("screenshots: the clipboard image is in a format pi cannot convert.", "warning");
					return;
				}
				bytes = Buffer.from(png.data, "base64");
				mime = "image/png";
			}
			const file = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extensionForMime(mime)}`);
			await writeFile(file, bytes);
			insertIntoEditor(ctx, [file]);
			ctx.ui.notify(`Pasted clipboard image (${formatBytes(bytes.length)}). It is attached when you send.`, "info");
		},
	});
}
