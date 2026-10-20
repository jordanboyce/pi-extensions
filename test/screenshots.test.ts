import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	applyReplacements,
	DEFAULTS,
	defaultScreenshotSources,
	findImagePaths,
	formatAge,
	imageLabel,
	isClipboardTemp,
	newestImages,
	quoteForPrompt,
	sniffImageMime,
	validateConfig,
	type FindOptions,
} from "../extensions/screenshots/attach.ts";

function files(platform: string, cwd: string, home: string, list: string[]): FindOptions {
	const set = new Set(platform === "win32" ? list.map((p) => p.toLowerCase()) : list);
	return { cwd, home, platform, isFile: (p) => set.has(platform === "win32" ? p.toLowerCase() : p) };
}

/** The text each match replaces, for readable assertions. */
function spans(text: string, opts: FindOptions): string[] {
	return findImagePaths(text, opts).map((f) => text.slice(f.start, f.end));
}

describe("sniffImageMime", () => {
	it("recognises PNG, JPEG, GIF and WebP", () => {
		assert.equal(sniffImageMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
		assert.equal(sniffImageMime(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
		assert.equal(sniffImageMime(Buffer.from("GIF89a....")), "image/gif");
		assert.equal(sniffImageMime(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
	});
	it("rejects BMP, text and short input", () => {
		assert.equal(sniffImageMime(Buffer.from("BM6\0\0\0")), null);
		assert.equal(sniffImageMime(Buffer.from("hello world")), null);
		assert.equal(sniffImageMime(new Uint8Array()), null);
	});
});

describe("findImagePaths (Windows)", () => {
	const shot = "C:\\Users\\Jo Doe\\Pictures\\Screenshots\\Screenshot 2026-10-13 204241.png";
	const opts = files("win32", "D:\\repo", "C:\\Users\\Jo Doe", [shot, "D:\\repo\\docs\\ui.PNG", "C:\\Users\\Jo Doe\\a.jpg"]);

	it("finds an unquoted path with spaces, as Alt+V inserts it", () => {
		const text = `what is wrong here ${shot} thanks`;
		const [f] = findImagePaths(text, opts);
		assert.equal(text.slice(f!.start, f!.end), shot);
		assert.equal(f!.path, shot);
	});
	it("includes surrounding quotes from terminal drag-and-drop", () => {
		assert.deepEqual(spans(`see "${shot}".`, opts), [`"${shot}"`]);
	});
	it("resolves relative and @-prefixed paths against cwd, case-insensitively", () => {
		const found = findImagePaths("compare @docs\\ui.PNG with docs/ui.png, ok", opts);
		assert.deepEqual(found.map((f) => f.written), ["docs\\ui.PNG", "docs/ui.png"]);
		assert.equal(found[0]!.start, "compare ".length);
		assert.equal(found[1]!.path, "D:\\repo\\docs\\ui.png");
	});
	it("expands ~ and allows trailing punctuation", () => {
		assert.deepEqual(spans("look at ~\\a.jpg.", opts), ["~\\a.jpg"]);
		assert.deepEqual(spans("(~/a.jpg)", opts), ["~/a.jpg"]);
	});
	it("ignores missing files, URLs and image names inside words", () => {
		assert.deepEqual(spans("missing.png https://example.com/docs/ui.png ui.pngs", opts), []);
	});
	it("reports offsets across lines", () => {
		const text = `first line\n${shot}\nand docs/ui.png`;
		const found = findImagePaths(text, opts);
		assert.deepEqual(
			found.map((f) => text.slice(f.start, f.end)),
			[shot, "docs/ui.png"],
		);
	});
});

describe("findImagePaths (POSIX)", () => {
	const opts = files("darwin", "/work", "/Users/jo", ["/Users/jo/Desktop/Screen Shot 1.png", "/work/b.png", "/work/a b.png"]);

	it("understands shell-escaped spaces", () => {
		const found = findImagePaths("this: /Users/jo/Desktop/Screen\\ Shot\\ 1.png", opts);
		assert.equal(found[0]!.path, "/Users/jo/Desktop/Screen Shot 1.png");
		assert.equal(found[0]!.written, "/Users/jo/Desktop/Screen Shot 1.png");
	});
	it("prefers the longest existing path", () => {
		assert.deepEqual(spans("look a b.png", opts), ["a b.png"]);
	});
	it("finds two paths on one line once each", () => {
		assert.deepEqual(spans("b.png vs b.png", opts), ["b.png", "b.png"]);
	});
});

describe("rewriting", () => {
	it("replaces spans with labels", () => {
		const text = 'see "C:\\x y.png" and z.png now';
		const out = applyReplacements(text, [
			{ start: text.indexOf("z.png"), end: text.indexOf("z.png") + 5, label: imageLabel(2, "z.png") },
			{ start: 4, end: 16, label: imageLabel(1, undefined) },
		]);
		assert.equal(out, "see [image 1] and [image 2: z.png] now");
	});
	it("recognises pi's clipboard temp files only in the temp dir", () => {
		const name = "pi-clipboard-0b8e2a4c-1f7d-4e7a-9a43-2c1e5d6f7a8b.png";
		assert.equal(isClipboardTemp(`C:\\Temp\\${name}`, "c:\\temp", "win32"), true);
		assert.equal(isClipboardTemp(`/tmp/${name}`, "/tmp", "linux"), true);
		assert.equal(isClipboardTemp(`/home/jo/${name}`, "/tmp", "linux"), false);
		assert.equal(isClipboardTemp("/tmp/shot.png", "/tmp", "linux"), false);
	});
	it("quotes paths with whitespace", () => {
		assert.equal(quoteForPrompt("C:\\a b.png"), '"C:\\a b.png"');
		assert.equal(quoteForPrompt("/a/b.png"), "/a/b.png");
	});
});

describe("screenshot folders", () => {
	it("uses Pictures\\Screenshots on Windows, including OneDrive, without duplicates", () => {
		const dirs = defaultScreenshotSources("win32", "C:\\Users\\jo", { USERPROFILE: "C:\\Users\\jo", OneDrive: "C:\\Users\\jo\\OneDrive", OneDriveConsumer: "C:\\Users\\jo\\OneDrive" }).map((s) => s.dir);
		assert.deepEqual(dirs, ["C:\\Users\\jo\\Pictures\\Screenshots", "C:\\Users\\jo\\OneDrive\\Pictures\\Screenshots"]);
	});
	it("filters shared folders by name on macOS and Linux", () => {
		const mac = defaultScreenshotSources("darwin", "/Users/jo", {});
		assert.equal(mac[0]!.dir, "/Users/jo/Desktop");
		assert.ok(mac[0]!.namePattern!.test("Screenshot 2026-10-20 at 10.00.00.png"));
		assert.ok(!mac[0]!.namePattern!.test("logo.png"));
		const linux = defaultScreenshotSources("linux", "/home/jo", { XDG_PICTURES_DIR: "$HOME/Bilder" });
		assert.deepEqual(linux.map((s) => s.dir), ["/home/jo/Bilder/Screenshots", "/home/jo/Bilder"]);
	});
	it("picks the newest images across folders", () => {
		const desktop = { dir: "/d", namePattern: /^Screenshot/ };
		const shots = { dir: "/s" };
		const newest = newestImages(
			[
				{ source: desktop, entries: [{ path: "/d/logo.png", name: "logo.png", mtimeMs: 900 }, { path: "/d/Screenshot 1.png", name: "Screenshot 1.png", mtimeMs: 300 }] },
				{ source: shots, entries: [{ path: "/s/a.png", name: "a.png", mtimeMs: 100 }, { path: "/s/b.jpg", name: "b.jpg", mtimeMs: 500 }, { path: "/s/notes.txt", name: "notes.txt", mtimeMs: 999 }] },
			],
			2,
		);
		assert.deepEqual(newest.map((e) => e.path), ["/s/b.jpg", "/d/Screenshot 1.png"]);
	});
	it("formats ages", () => {
		assert.equal(formatAge(5_000), "5s ago");
		assert.equal(formatAge(3 * 60_000), "3 min ago");
		assert.equal(formatAge(5 * 3_600_000), "5 h ago");
		assert.equal(formatAge(7 * 86_400_000), "7 days ago");
	});
});

describe("validateConfig", () => {
	it("fills defaults", () => {
		assert.deepEqual(validateConfig({}).config, DEFAULTS);
	});
	it("accepts every key", () => {
		const r = validateConfig({ autoAttach: false, maxImages: 3, maxBytes: 1000, staleAfterMinutes: 60, screenshotDirs: ["~/Shots"] });
		assert.deepEqual(r.config, { autoAttach: false, maxImages: 3, maxBytes: 1000, staleAfterMinutes: 60, screenshotDirs: ["~/Shots"] });
	});
	it("rejects bad values and unknown keys", () => {
		assert.match(validateConfig([]).error!, /JSON object/);
		assert.match(validateConfig({ maxImage: 3 }).error!, /unknown key "maxImage"/);
		assert.match(validateConfig({ maxImages: 0 }).error!, /positive integer/);
		assert.match(validateConfig({ autoAttach: "yes" }).error!, /true or false/);
		assert.match(validateConfig({ screenshotDirs: [] }).error!, /non-empty array/);
		assert.match(validateConfig({ screenshotDirs: [""] }).error!, /non-empty array/);
	});
});
