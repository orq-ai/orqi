/**
 * Session-only tool-confirmation policy parsed before Pi sees its arguments.
 * `plan` is read-only: the gate blocks every change until the user approves a
 * plan (src/plan.ts). `/plan` and alt+p switch it mid-session.
 */
export type PermissionMode = "prompt" | "auto" | "plan";

export type PermissionModeFlag = {
	argv: string[];
	mode: PermissionMode;
	error?: string;
};

const ONCE = "--auto, --plan or --permission-mode may be given only once";

/**
 * Take orqi's permission flag out of argv. Pi's extension flags are registered
 * after boot, but the local Bash tool and startup header need this decision
 * before the session is created.
 */
export function takePermissionModeFlag(argv: string[]): PermissionModeFlag {
	const kept: string[] = [];
	let mode: PermissionMode = "prompt";
	let seen = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--auto" || arg === "--plan") {
			if (seen) return { argv, mode, error: ONCE };
			mode = arg === "--auto" ? "auto" : "plan";
			seen = true;
			continue;
		}
		const isMode = arg === "--permission-mode" || arg.startsWith("--permission-mode=");
		if (!isMode) {
			kept.push(arg);
			continue;
		}
		const value = arg === "--permission-mode" ? argv[i + 1] : arg.slice(18);
		if (arg === "--permission-mode" && (!value || value.startsWith("-")))
			return { argv, mode, error: "--permission-mode requires prompt, auto or plan" };
		if (arg === "--permission-mode") i++;
		if (seen) return { argv, mode, error: ONCE };
		if (value !== "prompt" && value !== "auto" && value !== "plan")
			return { argv, mode, error: "--permission-mode must be prompt, auto or plan" };
		mode = value;
		seen = true;
	}
	return { argv: kept, mode };
}
