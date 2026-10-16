import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	EnvApplier,
	fingerprint,
	globToRegExp,
	guardMatch,
	guardPatternError,
	interpolate,
	normalizeRemoteUrl,
	parsePin,
	redactJson,
	redactText,
	resolveProfile,
	resolveValue,
	ruleMatches,
	secretsOf,
	selectProfile,
	validateConfig,
	type EnvSwitchConfig,
	type RepoIdentity,
	type ResolveDeps,
} from "../extensions/env-switch/profiles.ts";

const repo: RepoIdentity = {
	root: "D:\\work\\Acme\\billing-api",
	repoName: "billing-api",
	remote: "github.com/acme/billing-api",
	remoteNames: ["origin", "acme-upstream"],
};

describe("normalizeRemoteUrl", () => {
	it("makes ssh, https, scheme and port forms equivalent", () => {
		const expected = "github.com/acme/repo";
		assert.equal(normalizeRemoteUrl("git@github.com:Acme/Repo.git"), expected);
		assert.equal(normalizeRemoteUrl("https://github.com/Acme/Repo.git"), expected);
		assert.equal(normalizeRemoteUrl("https://user:tok3n@github.com/Acme/Repo"), expected);
		assert.equal(normalizeRemoteUrl("ssh://git@github.com:22/acme/repo.git"), expected);
		assert.equal(normalizeRemoteUrl("https://github.com/acme/repo/"), expected);
	});
});

describe("globToRegExp", () => {
	it("* stays in a segment, ** crosses segments, case-insensitive", () => {
		assert.ok(globToRegExp("github.com/acme/*").test("github.com/ACME/api"));
		assert.ok(!globToRegExp("github.com/acme/*").test("github.com/acme/a/b"));
		assert.ok(globToRegExp("d:/work/**").test("d:/work/acme/x/y"));
		assert.ok(globToRegExp("repo-?").test("repo-1"));
		assert.ok(!globToRegExp("a.b").test("axb"), "dot is literal");
	});
});

describe("ruleMatches", () => {
	it("matches remote URL globs", () => assert.ok(ruleMatches({ profile: "p", remote: "github.com/acme/*" }, repo)));
	it("matches remote names", () => assert.ok(ruleMatches({ profile: "p", remoteName: "acme-*" }, repo)));
	it("matches Windows paths written either way", () => {
		assert.ok(ruleMatches({ profile: "p", path: "D:/work/acme/**" }, repo));
		assert.ok(ruleMatches({ profile: "p", path: "D:\\work\\acme\\**" }, repo));
	});
	it("ANDs fields and ORs lists", () => {
		assert.ok(ruleMatches({ profile: "p", remote: ["x/y", "github.com/acme/*"], repo: "billing-*" }, repo));
		assert.ok(!ruleMatches({ profile: "p", remote: "github.com/acme/*", repo: "other" }, repo));
	});
	it("an empty rule matches nothing", () => assert.ok(!ruleMatches({ profile: "p" }, repo)));
	it("remote rules never match repos without a remote", () => {
		assert.ok(!ruleMatches({ profile: "p", remote: "*" }, { ...repo, remote: undefined }));
	});
});

describe("selectProfile precedence", () => {
	const config: EnvSwitchConfig = {
		profiles: { a: {}, b: {}, c: {}, d: {}, e: {} },
		rules: [{ profile: "c", repo: "billing-api" }],
		default: "d",
	};
	it("flag > env > pin > rule > default", () => {
		assert.deepEqual(selectProfile({ config, repo, flag: "a", envVar: "b", pinned: "e" }), { name: "a", source: "flag" });
		assert.deepEqual(selectProfile({ config, repo, envVar: "b", pinned: "e" }), { name: "b", source: "env" });
		assert.deepEqual(selectProfile({ config, repo, pinned: "e" }), { name: "e", source: "pin" });
		assert.deepEqual(selectProfile({ config, repo }), { name: "c", source: "rule" });
		assert.deepEqual(selectProfile({ config, repo: { ...repo, repoName: "zzz" } }), { name: "d", source: "default" });
	});
	it("returns undefined with no default and no match", () => {
		assert.equal(selectProfile({ config: { profiles: {} }, repo }), undefined);
	});
});

describe("parsePin", () => {
	it("takes the first non-comment line", () => assert.equal(parsePin("# comment\r\n\r\n acme-dev \r\nignored"), "acme-dev"));
	it("returns undefined for empty", () => assert.equal(parsePin("\n# x\n"), undefined));
});

describe("value resolution", () => {
	const deps = (env: NodeJS.ProcessEnv = {}): ResolveDeps => ({
		env,
		runCommand: async (c) => (c === "boom" ? Promise.reject(new Error("command exited 1")) : `secret-from-${c}\n`),
		readFile: async (p) => `file-contents-of-${p}\n`,
	});

	it("interpolates ${VAR} and errors on missing", () => {
		assert.equal(interpolate("Bearer ${T}", { T: "abc" }), "Bearer abc");
		assert.throws(() => interpolate("${MISSING}", {}), /MISSING/);
	});
	it("runs !commands and trims", async () => assert.equal(await resolveValue("!op read x", deps()), "secret-from-op read x"));
	it("reads file: values and trims", async () => assert.equal(await resolveValue("file:C:/k.txt", deps()), "file-contents-of-C:/k.txt"));
	it("collects per-variable errors without throwing", async () => {
		const config: EnvSwitchConfig = { profiles: { p: { env: { OK: "${A}", BAD: "${NOPE}", CMD: "!boom" } } } };
		const r = await resolveProfile("p", config, deps({ A: "1" }));
		assert.deepEqual(r.values, { OK: "1" });
		assert.equal(r.errors.length, 2);
	});
	it("throws on unknown profile", async () => {
		await assert.rejects(resolveProfile("nope", { profiles: { p: {} } }, deps()), /Unknown profile "nope"/);
	});
});

describe("EnvApplier", () => {
	it("sets, unsets and fully restores, even across repeated applies", () => {
		const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "global", OPENAI_API_KEY: "global-openai", KEEP: "1" };
		const a = new EnvApplier(env);
		a.apply({ ANTHROPIC_API_KEY: "repo", NEW_VAR: "x" }, ["OPENAI_API_KEY"]);
		a.apply({ ANTHROPIC_API_KEY: "repo2" }); // second apply must not overwrite remembered originals
		assert.equal(env.ANTHROPIC_API_KEY, "repo2");
		assert.equal(env.OPENAI_API_KEY, undefined);
		assert.equal(env.NEW_VAR, "x");
		a.restore();
		assert.deepEqual(env, { ANTHROPIC_API_KEY: "global", OPENAI_API_KEY: "global-openai", KEEP: "1" });
		assert.equal(a.active, false);
	});
	it("an explicit set wins over unset for the same name", () => {
		const env: NodeJS.ProcessEnv = {};
		new EnvApplier(env).apply({ X: "1" }, ["X"]);
		assert.equal(env.X, "1");
	});
});

describe("redaction", () => {
	const resolved = {
		name: "p",
		profile: { redact: ["ACME_BASE_URL"] },
		values: { ANTHROPIC_API_KEY: "sk-ant-secret-123456", ACME_TOKEN: "short", REGION: "us-east-1", ACME_BASE_URL: "https://internal.acme.example" },
		errors: [],
	};
	it("redacts secret-named and explicitly listed vars, skipping short/innocuous values", () => {
		const secrets = secretsOf(resolved);
		assert.deepEqual(Object.keys(secrets).sort(), ["ACME_BASE_URL", "ANTHROPIC_API_KEY"]);
	});
	it("replaces every occurrence, longest first", () => {
		const secrets = { A_KEY: "abcdefgh", B_KEY: "abcdefghij" };
		assert.equal(redactText("x abcdefghij y abcdefgh z abcdefgh", secrets), "x [redacted:B_KEY] y [redacted:A_KEY] z [redacted:A_KEY]");
	});
	it("redactJson walks nested structured content and keeps untouched references", () => {
		const secrets = { A_KEY: "abcdefgh" };
		const input = { out: "x abcdefgh", list: ["abcdefgh", 1, null], nested: { keep: "fine" }, n: 2 };
		const r = redactJson(input, secrets);
		assert.deepEqual(r, { out: "x [redacted:A_KEY]", list: ["[redacted:A_KEY]", 1, null], nested: { keep: "fine" }, n: 2 });
		assert.equal(r.nested, input.nested, "unchanged subtrees are the same reference");
		const clean = { a: ["b"], c: { d: "e" } };
		assert.equal(redactJson(clean, secrets), clean, "no change returns the same object");
	});
	it("fingerprint hides short values entirely", () => {
		assert.equal(fingerprint("sk-ant-secret-123456"), "…3456");
		assert.equal(fingerprint("short"), "set");
	});
});

describe("guarded commands", () => {
	const profile = { guard: ["\\bgit\\s+push\\b", "\\bterraform\\s+(apply|destroy)\\b"] };
	it("matches anywhere in the command line, case-insensitively", () => {
		assert.equal(guardMatch(profile, "git push"), "\\bgit\\s+push\\b");
		assert.equal(guardMatch(profile, "cd api && GIT  PUSH --force"), "\\bgit\\s+push\\b");
		assert.equal(guardMatch(profile, "terraform apply -auto-approve"), "\\bterraform\\s+(apply|destroy)\\b");
	});
	it("does not match unrelated commands or partial words", () => {
		assert.equal(guardMatch(profile, "git status"), undefined);
		assert.equal(guardMatch(profile, "git pushover"), undefined);
		assert.equal(guardMatch(profile, "terraform plan"), undefined);
		assert.equal(guardMatch({}, "git push"), undefined, "no guard list means nothing is blocked");
	});
	it("reports invalid patterns and never lets them block", () => {
		assert.match(guardPatternError("(unclosed") ?? "", /./);
		assert.equal(guardPatternError("\\bok\\b"), undefined);
		assert.equal(guardMatch({ guard: ["(unclosed"] }, "(unclosed"), undefined);
	});
});

describe("validateConfig", () => {
	it("accepts a good config", () => assert.ok(validateConfig({ profiles: { a: { env: { X: "1" } } }, rules: [{ profile: "a", repo: "x" }], default: "a" }).config));
	it("rejects dangling references and bad names", () => {
		assert.match(validateConfig({ profiles: { a: {} }, default: "zzz" }).error ?? "", /zzz/);
		assert.match(validateConfig({ profiles: { a: {} }, rules: [{ profile: "zzz" }] }).error ?? "", /zzz/);
		assert.match(validateConfig({ profiles: { a: { env: { "BAD NAME": "1" } } } }).error ?? "", /invalid variable name/);
		assert.match(validateConfig({ profiles: { a: { env: { X: 1 } } } }).error ?? "", /must be a string/);
	});
	it("rejects wrong shapes instead of crashing on them later", () => {
		assert.match(validateConfig({ profiles: { a: {} }, rules: { profile: "a" } }).error ?? "", /"rules" must be an array/);
		assert.match(validateConfig({ profiles: { a: "oops" } }).error ?? "", /profiles\.a must be an object/);
		assert.match(validateConfig({ profiles: { a: { unset: "OPENAI_API_KEY" } } }).error ?? "", /unset must be an array of strings/);
		assert.match(validateConfig({ profiles: { a: { redact: [1] } } }).error ?? "", /redact must be an array of strings/);
		assert.match(validateConfig({ profiles: { a: {} }, rules: [{ profile: "a", remote: 5 }] }).error ?? "", /rules\[0\]\.remote/);
		assert.match(validateConfig({ profiles: { a: {} }, redact: "no" }).error ?? "", /"redact" must be true or false/);
		assert.match(validateConfig({ profiles: { a: { guard: "git push" } } }).error ?? "", /guard must be an array of strings/);
		assert.match(validateConfig({ profiles: { a: { guard: ["ok", "(bad"] } } }).error ?? "", /guard\[1\] is not a valid regular expression/);
		assert.ok(validateConfig({ profiles: { a: { guard: ["\\bgit\\s+push\\b"] } } }).config);
		assert.ok(validateConfig({ profiles: { a: { unset: ["X"], redact: ["Y"], warn: "w" } }, rules: [{ profile: "a", path: ["p", "q"] }], redact: false }).config);
	});
});
