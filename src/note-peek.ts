/**
 * Peek: the whole note behind a memory event, as the rows of an overlay. The file is read when the overlay
 * opens (and again when it moves to another event), never in a render. A file that is missing or cannot be
 * read is a line of text, not an error. Everything drawn from a note goes through `printable`: a note is a
 * file the model wrote, and a terminal acts on what it is sent.
 */

import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { printable } from "./inspector-rows.ts";
import { age, type MemoryEvent, type MemorqState, noteKind } from "./memory-section.ts";

export interface PeekPaint {
	bold(text: string): string;
	dim(text: string): string;
}

export interface Peek {
	rows: string[];
	/** The file the rows came from: what `o` opens. Absent when the event has no note file to show. */
	path?: string;
}

/** How much of a file is read: a note is a few paragraphs, and one that is not should not stall the key. */
const MAX_BYTES = 64 * 1024;
/** Files looked at when a recall's top hit is found by its title: a store has dozens, not thousands. */
const MAX_SCAN = 400;
/** How much of a file a title scan reads: the heading sits at the top. */
const TITLE_BYTES = 8192;
const DAY = 86_400_000;

function readHead(path: string, max = MAX_BYTES): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(Math.min(max, fstatSync(fd).size));
		const got = readSync(fd, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, got).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

/** The frontmatter's `key: value` lines (flat, as memorq writes them) and the text after it. */
function split(text: string): { meta: Record<string, string>; body: string } {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { meta: {}, body: text };
	const meta: Record<string, string> = {};
	for (const line of match[1]!.split(/\r?\n/)) {
		const field = line.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
		if (field) meta[field[1]!] = printable(field[2]!).trim();
	}
	return { meta, body: text.slice(match[0].length) };
}

/** `today`, `9d old`, `3mo old`: how long ago the note was written. */
function oldness(ms: number): string {
	const days = Math.floor(ms / DAY);
	if (days < 1) return "today";
	if (days < 60) return `${days}d old`;
	return `${Math.floor(days / 30)}mo old`;
}

const shown = (path: string) => {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** A paragraph starts with `label:` (`Trigger:`, `Why:`), case-insensitively. */
const starts = (paragraph: string, ...labels: string[]) =>
	labels.some((label) => paragraph.toLowerCase().startsWith(`${label.toLowerCase()}:`));

/** One note as rows: title, facts, trigger, body, why, then the path. */
function noteRows(text: string, path: string, event: MemoryEvent, paint: PeekPaint, now: number, kind: string | undefined): string[] {
	const { meta, body } = split(text);
	const lines = body.split(/\r?\n/).map((line) => printable(line).trimEnd());
	const heading = lines.findIndex((line) => line.startsWith("# "));
	const title = (heading >= 0 ? lines[heading]!.slice(2).trim() : "") || event.title;
	if (heading >= 0) lines.splice(heading, 1);
	const paragraphs = lines
		.join("\n")
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean);
	const trigger = paragraphs.filter((paragraph) => starts(paragraph, "Trigger", "Use when"));
	const why = paragraphs.filter((paragraph) => starts(paragraph, "Why"));
	const rest = paragraphs.filter((paragraph) => !trigger.includes(paragraph) && !why.includes(paragraph));
	const created = Date.parse(meta.created ?? "");
	const written = Number.isFinite(created) && created <= now ? created : safeMtime(path);
	const facts = [
		meta.kind || kind,
		written === undefined ? undefined : oldness(Math.max(0, now - written)),
		meta.origin ? `origin: ${meta.origin}` : undefined,
	].filter(Boolean);
	// ponytail: "read in N sessions" is memorq's dream records, which orqi does not see; the line drops it.
	const out = [paint.bold(title)];
	if (facts.length) out.push(paint.dim(facts.join(" · ")));
	for (const group of [trigger, rest, why]) {
		if (group.length === 0) continue;
		out.push("", ...group.flatMap((paragraph, i) => (i === 0 ? [] : [""]).concat(paragraph.split("\n"))));
	}
	out.push("", paint.dim(shown(path)));
	return out;
}

function safeMtime(path: string): number | undefined {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
}

/** The title of a note file, from its first heading; empty when it has none or cannot be read. */
function titleOf(path: string): string {
	try {
		const { body } = split(readHead(path, TITLE_BYTES));
		return printable(body.match(/^# +(.+)$/m)?.[1] ?? "").trim();
	} catch {
		return "";
	}
}

/**
 * The note whose heading is `title` (case does not matter), looked for in the markdown files of each folder.
 * A recall tells orqi the title of its top hit and no path, so this is how peek finds the file: when the overlay
 * opens, never in a render, and at most `MAX_SCAN` files.
 */
export function findNoteByTitle(dirs: string[], title: string): string | undefined {
	const wanted = title.trim().toLowerCase();
	if (!wanted) return undefined;
	let scanned = 0;
	for (const dir of dirs) {
		if (!dir) continue;
		let names: string[];
		try {
			names = readdirSync(dir).filter((name) => name.endsWith(".md"));
		} catch {
			continue;
		}
		for (const name of names) {
			if (++scanned > MAX_SCAN) return undefined;
			const path = join(dir, name);
			if (titleOf(path).toLowerCase() === wanted) return path;
		}
	}
	return undefined;
}

/** What is known of an event that has no note file to show: a recall's query and result, a save's name. */
function knownRows(event: MemoryEvent, paint: PeekPaint, now: number): string[] {
	const ago = age(Math.max(0, now - event.at));
	const when = ago === "now" ? ago : `${ago} ago`;
	if (event.kind === "recall") {
		let result = "";
		if (event.hits === 0) result = "found nothing · ";
		else if (event.hits !== undefined) result = `found ${event.hits} · `;
		return [paint.bold(`"${event.title}"`), paint.dim(`recall · ${result}${when}`), ...(event.detail ? ["", paint.dim(event.detail)] : [])];
	}
	return [
		paint.bold(event.title),
		paint.dim(event.kind === "dupe" ? "already saved" : "saved"),
		...(event.detail ? ["", paint.dim(event.detail)] : []),
	];
}

/** The file an event stands for, if it has one orqi may open: a read's path, a save's inside a store, a recall's top hit by title. */
function pathOf(event: MemoryEvent, stores: MemorqState["stores"], roots: string[]): string | undefined {
	// A read was counted only for a path inside a store, so it is trusted as it is (a link's real path is not under the link).
	if (event.kind === "read") return event.path;
	if (event.kind === "recall") return event.top ? findNoteByTitle([stores.notes, stores.rules], event.top) : undefined;
	// memorq sent this one: it opens only what is inside a store.
	return event.path && noteKind(event.path, stores, roots) !== undefined ? event.path : undefined;
}

/**
 * The overlay's rows for `event`. Reads the file when there is one; a file that is gone or unreadable is a line
 * of text. `roots` are the machine stores a save's path may sit in (`noteRoots()`).
 */
export function peekOf(event: MemoryEvent, stores: MemorqState["stores"], paint: PeekPaint, now: number, roots: string[]): Peek {
	const path = pathOf(event, stores, roots);
	if (!path) return { rows: knownRows(event, paint, now) };
	try {
		const kind = noteKind(path, stores, roots);
		return { rows: noteRows(readHead(path), path, event, paint, now, kind), path };
	} catch (error) {
		const gone = (error as NodeJS.ErrnoException)?.code === "ENOENT";
		return {
			rows: [paint.bold(event.title), "", paint.dim(gone ? "The file is gone." : "The file cannot be read."), "", paint.dim(shown(path))],
			path,
		};
	}
}

/**
 * The editor as pi chooses it (its `externalEditor` setting, then `$VISUAL`, then `$EDITOR`; pi's `nano` default is left
 * out, so an unset editor says so) as a command and its arguments, the file last; undefined when none is set.
 * Split on spaces and run without a shell, so a path is one argument whatever it holds.
 */
export function editorCommand(env: NodeJS.ProcessEnv, path: string, configured?: string): { command: string; args: string[] } | undefined {
	const chosen = [configured, env.VISUAL, env.EDITOR].find((value) => typeof value === "string" && value.trim() !== "");
	const [command, ...args] = (chosen ?? "").trim().split(/\s+/).filter(Boolean);
	return command ? { command, args: [...args, path] } : undefined;
}
