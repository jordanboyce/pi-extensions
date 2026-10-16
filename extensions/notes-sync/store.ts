import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Appends `text`, creating the file (with `header`) and parent folders on first use. */
export async function appendToNote(file: string, header: string, text: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	try {
		await writeFile(file, header, { encoding: "utf8", flag: "wx" });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	await appendFile(file, text, "utf8");
}

/** Headings (`## …`) of the last `count` entries in a note file; todo lines are included. */
export async function recentEntries(file: string, count: number): Promise<string[]> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	const lines = text.split(/\r?\n/).filter((l) => l.startsWith("## ") || l.startsWith("- [ ] "));
	return lines.slice(-count).map((l) => (l.length > 140 ? `${l.slice(0, 137)}...` : l));
}
