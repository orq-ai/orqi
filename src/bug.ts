import { VERSION } from "./branding.ts";
import { openUrl } from "./harness-views.ts";

export const ORQI_ISSUES_URL = "https://github.com/orq-ai/orqi/issues/new";

type BuiltinSlashCommand = { name: string; description: string };

/** Rebrand the two pi-owned commands that orqi intercepts or presents. */
export function brandBuiltinCommands(commands: readonly BuiltinSlashCommand[]): void {
	for (const command of commands) {
		if (command.name === "quit") command.description = "Quit orqi";
		if (command.name === "bug") command.description = "Open a bug report in the orqi repository";
	}
}

/** The optional text following `/bug`, or undefined when this is not that command. */
export function bugHint(text: string): string | undefined {
	if (text === "/bug") return "";
	return text.startsWith("/bug ") ? text.slice("/bug ".length).trim() : undefined;
}

/**
 * A GitHub new-issue URL. The browser lets the user review and submit it; orqi
 * never uploads a transcript, diagnostics bundle, or report to pi.
 */
export function bugIssueUrl(hint = "", environment = `${process.platform} ${process.arch}`): string {
	const url = new URL(ORQI_ISSUES_URL);
	url.searchParams.set("title", hint ? `Bug: ${hint.slice(0, 80)}` : "Bug report");
	url.searchParams.set(
		"body",
		["## What happened?", "", hint || "_Describe the problem._", "", "## Environment", `- orqi ${VERSION}`, `- ${environment}`, ""].join(
			"\n",
		),
	);
	return url.toString();
}

export function openBugIssue(hint = "", opener: (url: string) => boolean = openUrl): { opened: boolean; url: string } {
	const url = bugIssueUrl(hint);
	return { url, opened: opener(url) };
}

type PiBugMode = {
	showStatus(message: string): void;
};

type PiInteractiveMode = {
	prototype: {
		handleBugCommand?: (hint?: string) => Promise<void>;
	};
};

/**
 * Pi handles built-in slash commands before extensions receive `input`, so
 * `/bug` cannot be overridden through `registerCommand`. Its dispatcher calls
 * this instance method dynamically; replace only that method before the mode
 * is constructed. The user still reviews and submits the GitHub issue.
 */
export function redirectPiBugCommand(InteractiveMode: PiInteractiveMode, opener: (url: string) => boolean = openUrl): void {
	InteractiveMode.prototype.handleBugCommand = async function (this: PiBugMode, hint?: string) {
		const { opened, url } = openBugIssue(hint, opener);
		this.showStatus(
			`${opened ? "Opening" : "Open"} a new orqi issue: ${url}\nReview and submit it in GitHub; no bug report was sent automatically.`,
		);
	};
}
