/**
 * Subagent types a user writes: `<name>.md` in `<agentDir>/agents/` or a trusted project's
 * `.orqi/agents/`, frontmatter (description, tools, rung) over the prompt. They sit beside the
 * built-ins in `AGENT_TYPES` and never replace one.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { TOOL_PREFIX } from "./mcp.ts";
import { AGENT_TYPES, type AgentType } from "./subagent.ts";

export interface AgentTypeProblem {
	file: string;
	reason: string;
}

const RUNGS = ["easy", "medium", "hard"] as const;

/** One file as a type, or why it is not one. */
function parse(file: string, name: string, builtIn: Record<string, AgentType>): AgentType | string {
	if (!/^[a-z0-9-]+$/.test(name)) return "the file name must be lowercase letters, digits and dashes";
	if (Object.hasOwn(builtIn, name)) return `shadows the built-in "${name}"`;
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(file, "utf8"));
	} catch {
		return "unparsable frontmatter";
	}
	const { frontmatter, body } = parsed;
	if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) return "description is required";
	const tools = frontmatter.tools;
	if (!Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => typeof tool === "string" && tool)) {
		return "tools must be a non-empty list of orq tool names";
	}
	const prefixed = tools.find((tool: string) => tool.startsWith(TOOL_PREFIX));
	if (prefixed) return `tool "${prefixed}": write the bare name, without ${TOOL_PREFIX}`;
	const rung = frontmatter.rung ?? "medium";
	if (!RUNGS.includes(rung as AgentType["rung"])) return "rung must be easy, medium or hard";
	const prompt = body.trim();
	if (!prompt) return "the prompt (the text after the frontmatter) is empty";
	return { description: frontmatter.description.trim(), tools: tools as string[], rung: rung as AgentType["rung"], prompt, source: file };
}

/** The built-ins plus every valid `*.md` in `dirs`; a later dir wins a name both define. */
export function loadAgentTypes(
	dirs: string[],
	builtIn: Record<string, AgentType> = AGENT_TYPES,
): { types: Record<string, AgentType>; problems: AgentTypeProblem[] } {
	const types = { ...builtIn };
	const problems: AgentTypeProblem[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let entries: string[];
		try {
			entries = readdirSync(dir)
				.filter((entry) => entry.endsWith(".md"))
				.sort();
		} catch {
			continue;
		}
		for (const entry of entries) {
			const file = join(dir, entry);
			const type = parse(file, entry.slice(0, -3), builtIn);
			if (typeof type === "string") problems.push({ file, reason: type });
			else types[entry.slice(0, -3)] = type;
		}
	}
	return { types, problems };
}

/**
 * Where types are read from: the agent dir always, the project's `.orqi/agents` only on a stored yes
 * (`/trust`) or `ORQI_TRUST_PROJECT=1`. Not `projectTrusted`: pi's trust list does not know the folder,
 * so a project holding only `.orqi/agents` reads as having nothing to trust, and a cloned repo's
 * prompt and tool list would run unasked.
 */
export function agentTypeDirs(cwd: string, agentDir: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const dirs = [join(agentDir, "agents")];
	if (env.ORQI_TRUST_PROJECT === "1" || new ProjectTrustStore(agentDir).get(cwd) === true) dirs.push(join(cwd, ".orqi", "agents"));
	return dirs;
}

/** The types for a session in `cwd`, and a note when the project's own were skipped as untrusted. */
export function agentTypesFor(cwd: string, agentDir: string, env: NodeJS.ProcessEnv = process.env) {
	const dirs = agentTypeDirs(cwd, agentDir, env);
	const loaded = loadAgentTypes(dirs);
	const project = join(cwd, ".orqi", "agents");
	// pi's untrusted-project warning does not know this folder, so /subagents says it.
	if (!dirs.includes(project) && existsSync(project)) {
		loaded.problems.push({ file: project, reason: "not loaded: this project is not trusted. /trust, then restart orqi" });
	}
	return loaded;
}
