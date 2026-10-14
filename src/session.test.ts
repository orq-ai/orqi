import { expect, test } from "bun:test";
import { createSessionRenewal, jwtExpiresAt, sessionStale } from "./session.ts";

const jwt = (exp: number) => `sk-orq-eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.sig`;

test("jwtExpiresAt reads a JWT's exp and skips everything else", () => {
	expect(jwtExpiresAt(jwt(1_700_000_000))).toBe(1_700_000_000_000);
	expect(jwtExpiresAt("sk-orq-not-a-jwt")).toBeUndefined();
	expect(jwtExpiresAt("plain-token")).toBeUndefined();
});

test("sessionStale fires inside the renewal window only for JWTs", () => {
	const now = 1_700_000_000_000;
	expect(sessionStale(jwt((now + 60_000) / 1000), now)).toBe(true);
	expect(sessionStale(jwt((now + 3_600_000) / 1000), now)).toBe(false);
	expect(sessionStale("sk-orq-api-key-without-jwt", now)).toBe(false);
});

test("an expiring API or profile key is never replaced", async () => {
	const expiringApiKey = jwt((Date.now() + 60_000) / 1000);
	let reads = 0;
	const renewal = createSessionRenewal({
		currentToken: () => expiringApiKey,
		isRenewable: () => false,
		readFreshSession: async () => {
			reads++;
			return jwt((Date.now() + 3_600_000) / 1000);
		},
	});
	expect(await renewal.ensureSession()).toEqual({ stale: false });
	expect(reads).toBe(0);
});

test("a stale browser session refreshes once for concurrent callers", async () => {
	const now = Date.now();
	let current = jwt((now + 60_000) / 1000);
	const fresh = jwt((now + 3_600_000) / 1000);
	let reads = 0;
	const renewal = createSessionRenewal({
		currentToken: () => current,
		isRenewable: () => true,
		readFreshSession: async () => {
			reads++;
			return fresh;
		},
	});
	const results = await Promise.all([renewal.ensureSession(), renewal.ensureSession(), renewal.ensureSession()]);
	expect(reads).toBe(1);
	expect(results.map((result) => result.refreshed)).toEqual([fresh, fresh, fresh]);
	current = fresh; // mirrors main.ts applying the replacement.
	expect(await renewal.ensureSession()).toEqual({ stale: false });
});

test("a forced renewal is available to retry an unexpected 401", async () => {
	let reads = 0;
	const current = jwt((Date.now() + 3_600_000) / 1000);
	const fresh = jwt((Date.now() + 7_200_000) / 1000);
	const renewal = createSessionRenewal({
		currentToken: () => current,
		isRenewable: () => true,
		readFreshSession: async () => {
			reads++;
			return fresh;
		},
	});
	expect(await renewal.ensureSession()).toEqual({ stale: false });
	expect((await renewal.ensureSession(true)).refreshed).toBe(fresh);
	expect(reads).toBe(1);
});

test("a missing or unchanged CLI session produces a recovery reason", async () => {
	const stale = jwt((Date.now() + 60_000) / 1000);
	const missing = createSessionRenewal({ currentToken: () => stale, isRenewable: () => true, readFreshSession: async () => undefined });
	expect((await missing.ensureSession()).reason).toContain("orq auth login");
	const unchanged = createSessionRenewal({ currentToken: () => stale, isRenewable: () => true, readFreshSession: async () => stale });
	expect((await unchanged.ensureSession()).reason).toContain("orq auth login");
});
