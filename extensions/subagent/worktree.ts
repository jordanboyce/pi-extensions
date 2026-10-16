/**
 * Git worktree management for pi-subagent, pure over an injectable `git` runner so it can be
 * tested against a real temporary repository. Paths come back normalized for the host OS
 * (backslashes on Windows); git accepts both forms.
 */

import { appendFile, readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import type { Changes } from "./core.ts";

export type Git = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface RepoInfo {
	/** Top-level directory of the working tree `cwd` belongs to. */
	root: string;
	/** The shared `.git` directory (the main repository's, even when `cwd` is a worktree). */
	commonDir: string;
	/** Commit the worktree branches from. */
	head: string;
	/** Current branch, or "HEAD" when detached. */
	branch: string;
}

export class GitError extends Error {}

async function run(git: Git, cwd: string, args: string[]): Promise<string> {
	const r = await git(args, cwd);
	if (r.code !== 0) throw new GitError((r.stderr || r.stdout || `git ${args.join(" ")} failed`).trim());
	return r.stdout.trim();
}

/** Undefined outside a git repository; throws when the repository has no commits yet. */
export async function repoInfo(git: Git, cwd: string): Promise<RepoInfo | undefined> {
	const top = await git(["rev-parse", "--show-toplevel"], cwd);
	if (top.code !== 0) return undefined;
	const root = normalize(top.stdout.trim());
	const common = await run(git, cwd, ["rev-parse", "--git-common-dir"]);
	const commonDir = normalize(isAbsolute(common) ? common : resolve(cwd, common));
	const headResult = await git(["rev-parse", "--verify", "HEAD"], cwd);
	if (headResult.code !== 0) throw new GitError("the repository has no commits yet; make one first (worktrees branch from HEAD)");
	const branch = await run(git, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	return { root, commonDir, head: headResult.stdout.trim(), branch };
}

/** Absolute path of a worktree: `worktreeDir` relative to the repository root unless absolute. */
export function worktreePath(root: string, worktreeDir: string, dirName: string): string {
	return normalize(isAbsolute(worktreeDir) ? join(worktreeDir, dirName) : join(root, worktreeDir, dirName));
}

/** The exclude pattern for a worktree dir inside the repository, or undefined when it is elsewhere. */
export function excludePattern(root: string, worktreeDir: string): string | undefined {
	const abs = normalize(isAbsolute(worktreeDir) ? worktreeDir : join(root, worktreeDir));
	const rel = normalize(abs).startsWith(normalize(root)) ? abs.slice(normalize(root).length) : undefined;
	if (rel === undefined || rel === "" || !/^[\\/]/.test(rel)) return undefined;
	return `/${rel.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "")}/`;
}

/** Adds the worktree dir to `.git/info/exclude` once, so worktrees never show up as untracked files. */
export async function ensureExcluded(commonDir: string, pattern: string): Promise<void> {
	const file = join(commonDir, "info", "exclude");
	let existing = "";
	try {
		existing = await readFile(file, "utf8");
	} catch {
		/* no exclude file yet */
	}
	if (existing.split(/\r?\n/).some((l) => l.trim() === pattern)) return;
	const sep = existing && !existing.endsWith("\n") ? "\n" : "";
	await appendFile(file, `${sep}# pi-subagent worktrees\n${pattern}\n`, "utf8");
}

export async function createWorktree(git: Git, opts: { root: string; path: string; branch: string; base: string }): Promise<void> {
	await run(git, opts.root, ["worktree", "add", "-b", opts.branch, opts.path, opts.base]);
}

/** What the child changed in `cwd` relative to `base`: commits, tracked and untracked files, diff stat. */
export async function collectChanges(git: Git, cwd: string, base: string): Promise<Changes> {
	const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const [log, names, others, stat, status] = await Promise.all([
		git(["log", "--oneline", "--no-decorate", `${base}..HEAD`], cwd),
		git(["diff", "--name-only", base], cwd),
		git(["ls-files", "--others", "--exclude-standard"], cwd),
		git(["diff", "--stat=100", base], cwd),
		git(["status", "--porcelain"], cwd),
	]);
	const untracked = lines(others.stdout);
	const files = [...new Set([...lines(names.stdout), ...untracked])].sort();
	let diffStat = stat.stdout.trimEnd();
	if (untracked.length) diffStat += `${diffStat ? "\n" : ""} ${untracked.length} untracked file${untracked.length === 1 ? "" : "s"}`;
	return { commits: lines(log.stdout), files, diffStat, dirty: status.stdout.trim().length > 0 };
}

export interface SharedSnapshot {
	head?: string;
	status: string;
}

/** `HEAD` and `git status --porcelain` before a shared-mode run; empty outside a repository. */
export async function snapshotShared(git: Git, cwd: string): Promise<SharedSnapshot | undefined> {
	const status = await git(["status", "--porcelain"], cwd);
	if (status.code !== 0) return undefined;
	const head = await git(["rev-parse", "--verify", "HEAD"], cwd);
	return { head: head.code === 0 ? head.stdout.trim() : undefined, status: status.stdout };
}

/**
 * Changes a shared-mode child made: files whose status changed plus files in commits it added.
 * Pre-existing uncommitted changes are left out, unlike {@link collectChanges}.
 */
export async function collectSharedChanges(git: Git, cwd: string, before: SharedSnapshot, statusDiff: (a: string, b: string) => string[]): Promise<Changes> {
	const lines = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const after = await git(["status", "--porcelain"], cwd);
	const files = new Set(statusDiff(before.status, after.stdout));
	let commits: string[] = [];
	if (before.head) {
		const log = await git(["log", "--oneline", "--no-decorate", `${before.head}..HEAD`], cwd);
		commits = lines(log.stdout);
		if (commits.length) for (const f of lines((await git(["diff", "--name-only", before.head, "HEAD"], cwd)).stdout)) files.add(f);
	}
	const sorted = [...files].sort();
	let diffStat = "";
	if (sorted.length && before.head) diffStat = (await git(["diff", "--stat=100", before.head, "--", ...sorted], cwd)).stdout.trimEnd();
	const touchedDirty = lines(after.stdout).some((l) => files.has(l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, "")));
	return { commits, files: sorted, diffStat, dirty: touchedDirty };
}

/**
 * Best-effort removal of a worktree and its branch; returns the first error message, if any.
 * The branch is deleted even when the worktree directory is already gone (or was never created).
 */
export async function removeWorktree(git: Git, opts: { root: string; path: string; branch: string }): Promise<string | undefined> {
	const rm = await git(["worktree", "remove", "--force", opts.path], opts.root);
	if (rm.code !== 0) await git(["worktree", "prune"], opts.root);
	const br = await git(["branch", "-D", opts.branch], opts.root);
	if (br.code !== 0) return br.stderr.trim() || "git branch -D failed";
	return rm.code === 0 ? undefined : rm.stderr.trim() || "git worktree remove failed";
}
