/** Session-only tool-confirmation policy parsed before Pi sees its arguments. */
export type PermissionMode = "prompt" | "auto";

export type PermissionModeFlag = {
	argv: string[];
	mode: PermissionMode;
	error?: string;
};

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
		if (arg === "--auto") {
			if (seen) return { argv, mode, error: "--auto or --permission-mode may be given only once" };
			mode = "auto";
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
			return { argv, mode, error: "--permission-mode requires prompt or auto" };
		if (arg === "--permission-mode") i++;
		if (seen) return { argv, mode, error: "--auto or --permission-mode may be given only once" };
		if (value !== "prompt" && value !== "auto") return { argv, mode, error: "--permission-mode must be prompt or auto" };
		mode = value;
		seen = true;
	}
	return { argv: kept, mode };
}
