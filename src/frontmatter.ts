/**
 * Make a plugin command's frontmatter parse as YAML.
 *
 * The orq plugin's commands are written for Claude Code, whose frontmatter
 * reader tolerates values YAML does not: `argument-hint: [list|get] [name]`
 * opens a flow sequence and then keeps going. pi parses strictly and shows a
 * "Prompt conflicts" block at every boot for it. So a value that does not
 * parse on its own line is quoted, and nothing else is touched. Used by
 * vendor.ts and the live updater; kept free of the skills lock so vendor.ts
 * can import it before the lock exists.
 */

import { parse } from "yaml";

export function normalizeCommand(text: string): string {
	const match = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!match) return text;
	const lines = match[1]!.split("\n").map((line) => {
		const field = line.match(/^([A-Za-z][\w-]*):\s+(.+)$/);
		if (!field) return line;
		try {
			parse(line);
			return line;
		} catch {
			return `${field[1]}: ${JSON.stringify(field[2]!.trim())}`;
		}
	});
	return `---\n${lines.join("\n")}\n---\n${text.slice(match[0].length)}`;
}
