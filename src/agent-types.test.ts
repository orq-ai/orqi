import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { agentTypeDirs, agentTypesFor, loadAgentTypes } from "./agent-types.ts";
import { AGENT_TYPES } from "./subagent.ts";

const VALID = "---\ndescription: Audits evaluators\ntools: [list_evaluators, get_experiment_run]\nrung: hard\n---\nYou audit evaluators.\n";

function dirWith(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "orqi-agents-"));
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

test("loads a valid file", () => {
	const dir = dirWith({ "auditor.md": VALID, "notes.txt": "ignored" });
	const { types, problems } = loadAgentTypes([dir]);
	expect(problems).toEqual([]);
	expect(types.auditor).toEqual({
		description: "Audits evaluators",
		tools: ["list_evaluators", "get_experiment_run"],
		rung: "hard",
		prompt: "You audit evaluators.",
		source: join(dir, "auditor.md"),
	});
	// The built-ins are always there.
	expect(Object.keys(types)).toEqual([...Object.keys(AGENT_TYPES), "auditor"]);
});

test("defaults rung to medium", () => {
	const dir = dirWith({ "auditor.md": "---\ndescription: d\ntools: [search_docs]\n---\nbody" });
	expect(loadAgentTypes([dir]).types.auditor?.rung).toBe("medium");
});

test("skips and reports a file that does not hold up", () => {
	const reason = (name: string, content: string) => {
		const { types, problems } = loadAgentTypes([dirWith({ [name]: content })]);
		expect(Object.keys(types)).toEqual(Object.keys(AGENT_TYPES));
		return problems.map((p) => p.reason);
	};
	expect(reason("a.md", "---\ndescription: d\n---\nbody")).toEqual(["tools must be a non-empty list of orq tool names"]);
	expect(reason("a.md", "---\ndescription: d\ntools: []\n---\nbody")).toEqual(["tools must be a non-empty list of orq tool names"]);
	expect(reason("a.md", "---\ndescription: d\ntools: [mcp__orq__search_docs]\n---\nbody")).toEqual([
		'tool "mcp__orq__search_docs": write the bare name, without mcp__orq__',
	]);
	expect(reason("a.md", "---\ndescription: d\ntools: [search_docs]\nrung: huge\n---\nbody")).toEqual(["rung must be easy, medium or hard"]);
	expect(reason("Upper.md", VALID)).toEqual(["the file name must be lowercase letters, digits and dashes"]);
	expect(reason("a.md", "---\ndescription: d\ntools: [search_docs]\n---\n  \n")).toEqual([
		"the prompt (the text after the frontmatter) is empty",
	]);
	expect(reason("a.md", "---\ndescription: [unclosed\n---\nbody")).toEqual(["unparsable frontmatter"]);
	expect(reason("a.md", "---\ntools: [search_docs]\n---\nbody")).toEqual(["description is required"]);
	expect(reason("docs.md", VALID)).toEqual(['shadows the built-in "docs"']);
});

test("a problem names its file", () => {
	const dir = dirWith({ "a.md": "no frontmatter" });
	expect(loadAgentTypes([dir]).problems[0]?.file).toBe(join(dir, "a.md"));
});

test("later dir wins on a clash", () => {
	const user = dirWith({ "auditor.md": VALID });
	const project = dirWith({ "auditor.md": VALID.replace("Audits evaluators", "Project auditor") });
	expect(loadAgentTypes([user, project]).types.auditor?.description).toBe("Project auditor");
});

test("a missing dir is not a problem", () => {
	expect(loadAgentTypes([join(tmpdir(), "orqi-no-such-dir")]).problems).toEqual([]);
});

test('built-ins carry source "built-in"', () => {
	for (const type of Object.values(loadAgentTypes([]).types)) expect(type.source).toBe("built-in");
});

test("agentTypeDirs omits the project dir when untrusted", () => {
	const cwd = mkdtempSync(join(tmpdir(), "orqi-project-"));
	mkdirSync(join(cwd, ".orqi"));
	writeFileSync(join(cwd, ".orqi", "settings.json"), "{}");
	const agentDir = mkdtempSync(join(tmpdir(), "orqi-agentdir-"));
	expect(agentTypeDirs(cwd, agentDir, {})).toEqual([join(agentDir, "agents")]);
	expect(agentTypeDirs(cwd, agentDir, { ORQI_TRUST_PROJECT: "1" })).toEqual([join(agentDir, "agents"), join(cwd, ".orqi", "agents")]);
});

test("a project whose only resource is .orqi/agents still needs a yes", () => {
	const cwd = mkdtempSync(join(tmpdir(), "orqi-project-"));
	mkdirSync(join(cwd, ".orqi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".orqi", "agents", "helper.md"), VALID);
	const agentDir = mkdtempSync(join(tmpdir(), "orqi-agentdir-"));
	// pi's trust list does not know the folder, so pi would call this project trusted: orqi does not.
	expect(agentTypeDirs(cwd, agentDir, {})).toEqual([join(agentDir, "agents")]);
	new ProjectTrustStore(agentDir).set(cwd, false);
	expect(agentTypeDirs(cwd, agentDir, {})).toEqual([join(agentDir, "agents")]);
	new ProjectTrustStore(agentDir).set(cwd, true);
	expect(agentTypeDirs(cwd, agentDir, {})).toEqual([join(agentDir, "agents"), join(cwd, ".orqi", "agents")]);
});

test("an untrusted project's types are reported as ignored, not silently dropped", () => {
	const cwd = mkdtempSync(join(tmpdir(), "orqi-project-"));
	mkdirSync(join(cwd, ".orqi", "agents"), { recursive: true });
	writeFileSync(join(cwd, ".orqi", "agents", "helper.md"), VALID);
	const agentDir = mkdtempSync(join(tmpdir(), "orqi-agentdir-"));
	const untrusted = agentTypesFor(cwd, agentDir, {});
	expect(untrusted.types.helper).toBeUndefined();
	expect(untrusted.problems).toEqual([
		{ file: join(cwd, ".orqi", "agents"), reason: "not loaded: this project is not trusted. /trust, then restart orqi" },
	]);
	const trusted = agentTypesFor(cwd, agentDir, { ORQI_TRUST_PROJECT: "1" });
	expect(trusted.types.helper?.description).toBe("Audits evaluators");
	expect(trusted.problems).toEqual([]);
});
