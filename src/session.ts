/**
 * Renewal of the short-lived token issued by `orq auth login`.
 *
 * Only browser sign-ins and direct CLI login sessions are renewable. API keys
 * and profile credentials can also be JWT-shaped, so token syntax alone must
 * never decide whether it is safe to replace the active credential.
 */

/** A session token is renewed this long before it would expire. */
const RENEW_SKEW_MS = 5 * 60 * 1000;

/** Read a JWT's `exp` claim in milliseconds, if it carries one. */
export function jwtExpiresAt(token: string): number | undefined {
	const payload = token.replace(/^sk-orq-/, "").split(".")[1];
	if (!payload) return undefined;
	try {
		const exp = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))?.exp;
		return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
	} catch {
		return undefined;
	}
}

/** True when the JWT is inside the proactive renewal window. */
export function sessionStale(token: string | undefined, now = Date.now()): boolean {
	const exp = token ? jwtExpiresAt(token) : undefined;
	return exp !== undefined && exp - RENEW_SKEW_MS <= now;
}

export interface SessionRenewal {
	/** The active browser/session token was within the renewal window. */
	stale: boolean;
	/** A replacement token supplied by the CLI login session. */
	refreshed?: string;
	/** A recoverable reason to show the user when renewal failed. */
	reason?: string;
}

export interface SessionRenewalOptions {
	/** The credential token currently in use by router and MCP. */
	currentToken: () => string | undefined;
	/** True only for a verified OAuth browser login or CLI login session. */
	isRenewable: () => boolean;
	/** `orq auth whoami` via the candidate reader; it refreshes the CLI session. */
	readFreshSession: () => Promise<string | undefined>;
}

/**
 * Make a single-flight session renewal gate. Applying a returned token remains
 * the caller's responsibility, so the caller can update the router, auth file,
 * and MCP server in one atomic path.
 */
export function createSessionRenewal(options: SessionRenewalOptions): { ensureSession: (force?: boolean) => Promise<SessionRenewal> } {
	let inFlight: Promise<SessionRenewal> | undefined;

	const attempt = async (force: boolean): Promise<SessionRenewal> => {
		if (!options.isRenewable()) return { stale: false };
		const current = options.currentToken();
		const stale = sessionStale(current);
		if (!force && !stale) return { stale: false };
		try {
			const fresh = await options.readFreshSession();
			if (!fresh) return { stale, reason: "no orq login session to refresh from; run `orq auth login`" };
			if (fresh === current) return { stale, reason: "the login session could not be renewed; run `orq auth login`" };
			return { stale, refreshed: fresh };
		} catch (error) {
			return { stale, reason: error instanceof Error ? error.message : String(error) };
		}
	};

	return {
		ensureSession: (force = false) => {
			if (!force && (!options.isRenewable() || !sessionStale(options.currentToken()))) return Promise.resolve({ stale: false });
			if (!inFlight)
				inFlight = attempt(force).finally(() => {
					inFlight = undefined;
				});
			return inFlight;
		},
	};
}
