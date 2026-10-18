/** Local filesystem tools deliberately exposed by orqi.
 *
 * Keep this list small: targeted edits retain pi's native inline diff preview,
 * while Bash execution is held behind orqi's permission gate.
 */
import { createBashTool, createEditTool, createReadTool } from "@earendil-works/pi-coding-agent";

export const LOCAL_TOOL_NAMES = ["read", "edit", "bash"] as const;

/** Read and targeted-edit tools, both scoped by pi to the session working directory. */
export function createLocalTools(cwd: string) {
	return [createReadTool(cwd), createEditTool(cwd), createBashTool(cwd)];
}
