/** Local filesystem tools deliberately exposed by orqi.
 *
 * Keep this list small: targeted edits retain pi's native inline diff preview,
 * while shell execution remains outside orqi's default permissions.
 */
import { createEditTool, createReadTool } from "@earendil-works/pi-coding-agent";

export const LOCAL_FILE_TOOL_NAMES = ["read", "edit"] as const;

/** Read and targeted-edit tools, both scoped by pi to the session working directory. */
export function createLocalFileTools(cwd: string) {
	return [createReadTool(cwd), createEditTool(cwd)];
}
