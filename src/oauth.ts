/**
 * "Sign in with an account" for orq in pi's /login: the browser login the orq
 * CLI already does (OAuth device flow), surfaced where pi users look for it.
 *
 * pi lists a provider under "Sign in with an account" only when it registers
 * an OAuth flow; orqi's `orq` provider had an API key only, so the list said
 * "No account providers available". This flow runs `orq auth login`, shows
 * pi's device-code view with the CLI's URL and code, waits for the approval,
 * then takes the login session's token through `orq auth whoami` (auth stays
 * the CLI's business, as everywhere else in orqi). Refreshing asks whoami
 * again: it refreshes an expiring token itself.
 */

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export interface DeviceLogin {
	url?: string;
	code?: string;
}

/** The CLI's `- Open: <url>` and `- Code: XXXX-XXXX` lines. */
export function parseDeviceLogin(output: string): DeviceLogin {
	const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
	const url = clean.match(/Open:\s*(https?:\/\/\S+)/)?.[1];
	// The code line follows the URL; the URL already carries it as user_code.
	const code = clean.match(/Code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] ?? url?.match(/[?&]user_code=([A-Z0-9-]+)/)?.[1];
	return { url, code };
}

/** How long a session token is trusted when it carries no expiry of its own. */
const TOKEN_TTL_MS = 50 * 60 * 1000;

/**
 * When pi should ask for a fresh token: a minute before the JWT's own `exp`.
 * A fixed TTL outlived the CLI's 30-minute tokens, so pi kept sending an
 * expired one and every model call failed with 401 until a restart. Never
 * less than a minute out, so a token near its end does not refresh in a loop.
 */
export function expiresAt(token: string, now = Date.now()): number {
	let exp: unknown;
	try {
		exp = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).exp;
	} catch {
		// Not a JWT: the fixed TTL.
	}
	const own = typeof exp === "number" ? exp * 1000 - 60_000 : now + TOKEN_TTL_MS;
	return Math.max(now + 60_000, Math.min(own, now + TOKEN_TTL_MS));
}

interface Callbacks {
	onDeviceCode(info: { userCode: string; verificationUri: string }): void;
	onProgress?(message: string): void;
	signal?: AbortSignal;
}

/**
 * The provider `oauth` block. `sessionToken` reads the login session's token
 * (credentialCandidates' session entry); `run` is injectable for tests.
 * `onSignedIn` hears the token the moment the sign-in succeeds: pi fires no
 * event when it stores the credential, so this is how the tools reconnect
 * without waiting for the next message. Not awaited, so pi's own save and
 * "Logged in" are not held up by the reconnect.
 */
export function orqOAuth(
	sessionToken: () => string | undefined,
	run: (args: string[], onOutput: (chunk: string) => void, signal?: AbortSignal) => Promise<number> = runCli,
	onSignedIn?: (token: string) => void,
) {
	const fresh = (refreshMarker = "orq-cli-session") => {
		const access = sessionToken();
		if (!access) throw new Error("orq auth whoami has no login session: run `orq auth login`");
		return { access, refresh: refreshMarker, expires: expiresAt(access) };
	};
	return {
		name: "orq.ai (browser)",
		login: async (callbacks: Callbacks) => {
			let output = "";
			let shown = false;
			const code = await run(
				["auth", "login", "--no-input"],
				(chunk) => {
					output += chunk;
					const device = parseDeviceLogin(output);
					if (!shown && device.url) {
						shown = true;
						callbacks.onDeviceCode({ userCode: device.code ?? "", verificationUri: device.url });
						callbacks.onProgress?.("Waiting for the approval in the browser…");
					}
				},
				callbacks.signal,
			);
			if (code !== 0) throw new Error(output.trim().split("\n").at(-1) || `orq auth login exited with ${code}`);
			const credentials = fresh();
			onSignedIn?.(credentials.access);
			return credentials;
		},
		refreshToken: async (_credentials: unknown) => fresh(),
		getApiKey: (credentials: { access: string }) => credentials.access,
	};
}

/**
 * A browser sign-in pi stored whose token the API refused, while the login
 * session it copies was accepted: write the session's token over it, which is
 * what pi's refresh would have done had it known the token was stale. pi
 * re-reads auth.json when the file changes, so the model runtime, which
 * prefers this entry over ORQ_API_KEY, stops failing with 401. A pasted key
 * is never touched: it is not the session's to replace. True when rewritten.
 */
export function refreshStoredSignIn(authPath: string, sessionToken: string): boolean {
	try {
		const data = JSON.parse(readFileSync(authPath, "utf8"));
		const stored = data?.orq;
		if (stored?.type !== "oauth" || stored.access === sessionToken) return false;
		data.orq = { ...stored, access: sessionToken, expires: expiresAt(sessionToken) };
		writeFileSync(authPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
		return true;
	} catch {
		return false;
	}
}

/** The token of pi's browser sign-in, never a pasted API key. */
export function storedOAuthToken(authPath: string): string | undefined {
	try {
		const stored = JSON.parse(readFileSync(authPath, "utf8"))?.orq;
		return stored?.type === "oauth" && typeof stored.access === "string" ? stored.access : undefined;
	} catch {
		return undefined;
	}
}

/** A browser sign-in pi stored whose token is past the expiry pi would refresh it at. */
export function signInExpired(authPath: string, now = Date.now()): boolean {
	try {
		const stored = JSON.parse(readFileSync(authPath, "utf8"))?.orq;
		return stored?.type === "oauth" && typeof stored.expires === "number" && stored.expires <= now;
	} catch {
		return false;
	}
}

/** Run the orq CLI, streaming its output; the abort signal kills it. */
function runCli(args: string[], onOutput: (chunk: string) => void, signal?: AbortSignal): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn("orq", args, { stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (data) => onOutput(String(data)));
		child.stderr.on("data", (data) => onOutput(String(data)));
		const abort = () => child.kill();
		signal?.addEventListener("abort", abort, { once: true });
		child.on("error", () => resolve(127));
		child.on("close", (code) => {
			signal?.removeEventListener("abort", abort);
			resolve(code ?? 1);
		});
	});
}
