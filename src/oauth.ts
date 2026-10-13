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

/** Minutes a session token is trusted before pi asks for a refresh (the CLI's own tokens last longer). */
const TOKEN_TTL_MS = 50 * 60 * 1000;

interface Callbacks {
	onDeviceCode(info: { userCode: string; verificationUri: string }): void;
	onProgress?(message: string): void;
	signal?: AbortSignal;
}

/**
 * The provider `oauth` block. `sessionToken` reads the login session's token
 * (credentialCandidates' session entry); `run` is injectable for tests.
 */
export function orqOAuth(
	sessionToken: () => string | undefined,
	run: (args: string[], onOutput: (chunk: string) => void, signal?: AbortSignal) => Promise<number> = runCli,
) {
	const fresh = (refreshMarker = "orq-cli-session") => {
		const access = sessionToken();
		if (!access) throw new Error("orq auth whoami has no login session: run `orq auth login`");
		return { access, refresh: refreshMarker, expires: Date.now() + TOKEN_TTL_MS };
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
			return fresh();
		},
		refreshToken: async (_credentials: unknown) => fresh(),
		getApiKey: (credentials: { access: string }) => credentials.access,
	};
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
