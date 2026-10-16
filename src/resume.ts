/**
 * Resuming a session: `orqi --session <id>`, the command pi's quit hint names
 * ("To resume this session: orqi --session <id>", from piConfig.name).
 */

import { SessionManager } from "@earendil-works/pi-coding-agent";

export type ResolvedSession = { path: string } | { elsewhere: string } | { missing: true };

/** The parts of SessionManager the lookup needs, injectable for tests. */
export interface SessionLookup {
	findById(cwd: string, id: string): string | undefined;
	list(cwd: string): Promise<{ id: string; path: string }[]>;
	listAll(): Promise<{ id: string; path: string; cwd: string }[]>;
}

const sessions: SessionLookup = {
	findById: (cwd, id) => SessionManager.findById(cwd, id),
	list: (cwd) => SessionManager.list(cwd),
	listAll: () => SessionManager.listAll(),
};

/**
 * What `--session <arg>` names, the way pi resolves it: a path as is, else an
 * exact id, else an id prefix, in this directory. A session from another
 * directory is reported rather than forked, since its tools and files belong there.
 */
export async function resolveSession(arg: string, cwd: string, lookup: SessionLookup = sessions): Promise<ResolvedSession> {
	if (arg.includes("/") || arg.includes("\\") || arg.endsWith(".jsonl")) return { path: arg };
	const exact = lookup.findById(cwd, arg);
	if (exact) return { path: exact };
	const local = (await lookup.list(cwd)).find((session) => session.id.startsWith(arg));
	if (local) return { path: local.path };
	const all = await lookup.listAll();
	const global = all.find((session) => session.id === arg) ?? all.find((session) => session.id.startsWith(arg));
	return global ? { elsewhere: global.cwd } : { missing: true };
}
