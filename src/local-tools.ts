/** Local filesystem tools deliberately exposed by orqi.
 *
 * Keep this list small: targeted edits retain pi's native inline diff preview,
 * while Bash execution is held behind orqi's permission gate.
 */
import { createBashTool, createEditTool, createReadTool } from "@earendil-works/pi-coding-agent";

export const LOCAL_TOOL_NAMES = ["read", "edit", "bash"] as const;

/**
 * pi tools orqi switches off. pi activates its own `write` by default whenever a
 * session is created without a tool list, so leaving it out of `createLocalTools`
 * is not enough: it would still reach the model, outside the permission gate.
 */
export const EXCLUDED_TOOLS = ["write"];

/** Read and targeted-edit tools, both scoped by pi to the session working directory. */
export function createLocalTools(cwd: string) {
	return [createReadTool(cwd), createEditTool(cwd), createBashTool(cwd)];
}
