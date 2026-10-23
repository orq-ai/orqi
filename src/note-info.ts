/**
 * What a note file says about itself: its title and the trigger it applies to. The sidebar shows a note it
 * read by its title, and a read is only a path, so the file is opened once per path (again only when its
 * modified time moved) when the read is counted, never in a render, where a slow disk would stall the frame.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { printable } from "./inspector-rows.ts";

export interface NoteInfo {
	title: string;
	/** When the note applies: its `Trigger:` line (a skill's `Use when:`); absent when it has none. */
	trigger?: string;
}

/** How much of a file is read: the heading and the trigger sit at the top, and a note can be long. */
const HEAD = 8192;

/**
 * A file name as words, for a note whose file cannot be read: `fix-pr-conflicts-c12ce7e7.md` is `Fix pr
 * conflicts` (memorq ends a name with a hash of 8 hex digits), and a skill's `SKILL.md` takes its folder's name.
 */
export function slugTitle(path: string): string {
	let name = basename(path);
	if (name === "SKILL.md") name = basename(dirname(path));
	const words = name
		.replace(/\.md$/, "")
		.replace(/-[0-9a-f]{8}$/, "")
		.replace(/[-_]+/g, " ")
		.trim();
	return words ? words[0]!.toUpperCase() + words.slice(1) : "note";
}

/** A note's text as its title and trigger. The frontmatter is skipped; without a heading the title is the file name's words. */
export function noteInfoOf(text: string, path: string): NoteInfo {
	const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const title = printable(body.match(/^# +(.+)$/m)?.[1] ?? "").trim();
	const trigger = printable(body.match(/^(?:Trigger|Use when):[ \t]*(.+)$/m)?.[1] ?? "").trim();
	return { title: title || slugTitle(path), ...(trigger ? { trigger } : {}) };
}

/**
 * The titles of the notes read this session. `load` opens the file (when new, or its modified time moved) and
 * is called off the render path; `get` only looks, and answers the file name's words until a load has read it.
 * A file that cannot be read is no failure: the name stays, and a later load tries again.
 */
export class NoteInfos {
	private cache = new Map<string, { mtime: number; info: NoteInfo }>();

	constructor(private readText: (path: string) => string = (path) => readFileSync(path, "utf8").slice(0, HEAD)) {}

	load(path: string): void {
		if (!path) return;
		try {
			const mtime = statSync(path).mtimeMs;
			if (this.cache.get(path)?.mtime === mtime) return;
			this.cache.set(path, { mtime, info: noteInfoOf(this.readText(path).slice(0, HEAD), path) });
		} catch {
			// Missing or unreadable: keep what was known, or the file name's words.
		}
	}

	get(path: string): NoteInfo {
		return this.cache.get(path)?.info ?? { title: slugTitle(path) };
	}
}
