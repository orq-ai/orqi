/**
 * The latest orq.ai release, in the terminal.
 *
 * `docs.orq.ai/changelog.md` always serves the newest release as Markdown:
 * `# Release 4.16`, then one `<Update label="…" description="…">` block per
 * headline. That is parsed into rows and cached for 24 h beside the
 * catalogues; any failure falls back to the stale cache, then to the URL.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CHANGELOG_MD = "https://docs.orq.ai/changelog.md";
const TTL_MS = 24 * 60 * 60 * 1000;

export interface Release {
	title: string;
	items: { label: string; tag?: string; summary: string }[];
}

/** First sentence of a block's prose, stripped of Markdown and MDX. */
function firstSentence(body: string): string {
	const lines = body.split("\n").map((line) => line.trim());
	const prose = lines.filter((line) => line && !/^[<*|!-]/.test(line));
	// Blocks that are only a bullet list ("New features") summarise by their first bullet.
	const source = prose.length ? prose : lines.filter((line) => /^[*-] /.test(line)).slice(0, 1).map((line) => line.slice(2));
	const text = source
		.join(" ")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/<[^>]+>/g, "");
	const end = text.search(/\.(\s|$)/);
	return (end >= 0 ? text.slice(0, end + 1) : text).slice(0, 160);
}

export function parseChangelog(md: string): Release {
	const title = md.match(/^# (.+)$/m)?.[1]?.trim() ?? "orq.ai changelog";
	const items: Release["items"] = [];
	const blocks = md.matchAll(/<Update\s+label="([^"]+)"(?:\s+description="([^"]*)")?[^>]*>([\s\S]*?)<\/Update>/g);
	for (const [, label, description, body] of blocks) {
		const tag = description?.match(/\b(Beta|Alpha|Preview)\b/i)?.[1];
		items.push({ label: label!, tag, summary: firstSentence(body ?? "") });
	}
	return { title, items };
}

/** The release plus how old the copy is, or undefined when there is nothing at all. */
export async function latestRelease(agentDir: string, fetchImpl: typeof fetch = fetch): Promise<{ release: Release; ageMs: number } | undefined> {
	const cache = join(agentDir, "whatsnew.md");
	const age = existsSync(cache) ? Date.now() - statSync(cache).mtimeMs : Infinity;
	if (age < TTL_MS) return { release: parseChangelog(readFileSync(cache, "utf8")), ageMs: age };
	try {
		const res = await fetchImpl(CHANGELOG_MD, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) throw new Error(String(res.status));
		const md = await res.text();
		writeFileSync(cache, md);
		return { release: parseChangelog(md), ageMs: 0 };
	} catch {
		return existsSync(cache) ? { release: parseChangelog(readFileSync(cache, "utf8")), ageMs: age } : undefined;
	}
}

export function ageLabel(ms: number): string {
	if (ms < 60_000) return "just fetched";
	if (ms < 3_600_000) return `cached ${Math.round(ms / 60_000)} min ago`;
	return `cached ${Math.round(ms / 3_600_000)} h ago`;
}
