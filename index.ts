import { access } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ReadonlySessionManager } from "@oh-my-pi/pi-coding-agent";

// OMP 19.1 launch flags. Unknown flags fail closed rather than replaying a prompt
// as a flag value. Extension-owned flags use their registered runtime type.
const FLAG_TYPES: Record<string, "string" | "boolean" | "optional"> = {
	"--cwd": "string", "--config": "string", "--add-dir": "string", "--mode": "string",
	"--fork": "string", "--provider": "string", "--model": "string", "--smol": "string",
	"--slow": "string", "--goal": "string", "--plan": "string", "--prewalk-into": "string",
	"--plan-yolo-into": "string", "--max-time": "string", "--warn-cost": "string",
	"--max-cost": "string", "--service-tier": "string", "--spinner-interval": "string",
	"--max-fps": "string", "--motion": "string", "--api-key": "string",
	"--system-prompt": "string", "--system-prompt-template": "string",
	"--append-system-prompt": "string", "--provider-session-id": "string",
	"--prompt-cache-key": "string", "--session-dir": "string", "--models": "string",
	"--tools": "string", "--thinking": "string", "--export": "string", "--hook": "string",
	"--extension": "string", "-e": "string", "--trusted-extension": "string",
	"--plugin-dir": "string", "--skills": "string", "--approval-mode": "string",
	"--profile": "string", "--alias": "string",
	"--allow-home": "boolean", "--no-session": "boolean", "--continue": "boolean",
	"-c": "boolean", "--from-claude": "boolean", "--from-codex": "boolean",
	"--prewalk": "boolean", "--no-prewalk": "boolean", "--plan-yolo": "boolean",
	"--no-tools": "boolean", "--no-judge": "boolean", "--no-spotlight": "boolean",
	"--offline": "boolean", "--no-lsp": "boolean", "--no-pty": "boolean",
	"--hide-thinking": "boolean", "--advisor": "boolean", "--wait-async": "boolean",
	"--external-thinking": "boolean", "--print": "boolean", "-p": "boolean",
	"--print-thoughts": "boolean", "--no-extensions": "boolean", "--no-skills": "boolean",
	"--no-rules": "boolean", "--no-context-files": "boolean", "--no-title": "boolean",
	"--no-ui": "boolean", "--auto-approve": "boolean", "--yolo": "boolean",
	"--resume": "optional", "-r": "optional", "--restore": "optional", "--session": "optional",
};
const DROP_FLAGS: Record<string, true> = {
	"--resume": true, "-r": true, "--restore": true, "--session": true,
	"--continue": true, "-c": true, "--fork": true, "--from-claude": true,
	"--from-codex": true, "--goal": true, "--cwd": true, "--config": true,
	"--model": true, "--provider": true, "--thinking": true, "--session-dir": true,
	"--mode": true, "--print": true, "-p": true, "--print-thoughts": true, "--no-ui": true,
};
const SCOPE_KEYS = [
	"PI_CONFIG_DIR", "OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_SESSION_DIR",
	"XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME",
] as const;

type Placement = "pane" | "tab";

export function startupFlags(
	argv: readonly string[],
	getFlag: (name: string) => string | boolean | undefined,
): { args: string[]; cacheKeyPinned: boolean } {
	const args: string[] = [];
	let cacheKeyPinned = false;
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i]!;
		if (token === "--") break;
		if (!token.startsWith("-")) continue; // Prompts, attachments, and `launch` aren't replayed.
		const equals = token.startsWith("--") ? token.indexOf("=") : -1;
		const flag = equals < 0 ? token : token.slice(0, equals);
		const extensionValue = flag.startsWith("--") ? getFlag(flag.slice(2)) : undefined;
		const kind = typeof extensionValue === "boolean" ? "boolean"
			: FLAG_TYPES[flag] ?? (typeof extensionValue === "string" ? "string" : undefined);
		if (!kind) throw new Error(`Unsupported startup flag ${flag}; update omp-rex before forking.`);
		let consumesNext = equals < 0 && kind === "string";
		if (kind === "optional" || flag === "--plan") {
			consumesNext = equals < 0 && kind !== "boolean" && !!argv[i + 1] && !argv[i + 1]!.startsWith("-");
		}
		if (flag === "--api-key") {
			throw new Error("Cannot forward --api-key safely. Use OMP's credential store or the Rex login environment.");
		}
		const value = consumesNext ? argv[++i] : undefined;
		if (consumesNext && value === undefined) throw new Error(`Missing value for ${flag}.`);
		if (Object.hasOwn(DROP_FLAGS, flag)) continue;
		if (flag === "--prompt-cache-key") cacheKeyPinned = true;
		args.push(token);
		if (value !== undefined) args.push(value);
	}
	return { args, cacheKeyPinned };
}

function canFlush(manager: ReadonlySessionManager): manager is ReadonlySessionManager & { flush(): Promise<void> } {
	// OMP 19.1 exposes the live manager, although its readonly type omits flush.
	// Refuse a future read-only facade rather than launching from stale history.
	return "flush" in manager && typeof manager.flush === "function";
}

function scopedCommand(pi: ExtensionAPI, args: string[]): string[] {
	const scope: Record<string, string | undefined> = {};
	for (const key of SCOPE_KEYS) scope[key] = process.env[key];
	scope.PI_CODING_AGENT_DIR = pi.pi.getAgentDir();
	scope.PI_CONFIG_FILES = pi.pi.settings.getConfigFiles().join(delimiter);
	const unset: string[] = [];
	const assignments: string[] = [];
	for (const [key, value] of Object.entries(scope)) {
		if (value) assignments.push(`${key}=${value}`);
		else unset.push("-u", key);
	}
	// Compiled OMP's argv[1] is a virtual Bun path, not an executable on disk.
	const entry = process.argv[1];
	const command = !entry || entry.startsWith("/$bunfs/")
		? [process.execPath]
		: [process.execPath, entry];
	return ["/usr/bin/env", ...unset, ...assignments, ...command, ...args];
}

export default function rexFork(pi: ExtensionAPI): void {
	let launching = false;
	const launchResult = pi.zod.object({ block_ids: pi.zod.array(pi.zod.string()).min(1) });

	async function fork(placement: Placement, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui" || ctx.agent.kind !== "main") {
			ctx.ui.notify("Rex forks require the main interactive OMP session.", "error");
			return;
		}
		const session = process.env.REX_SESSION;
		const block = process.env.REX_BLOCK;
		if (!session || !block) {
			ctx.ui.notify("Rex forks require REX_SESSION and REX_BLOCK; start OMP inside Rex.", "error");
			return;
		}
		if (launching) {
			ctx.ui.notify("A Rex fork is already being opened.", "warning");
			return;
		}
		if (ctx.sessionModes?.getState().vibe === "active") {
			ctx.ui.notify("Exit vibe mode before forking.", "warning");
			return;
		}

		launching = true;
		try {
			const { args, cacheKeyPinned } = startupFlags(process.argv.slice(2), pi.getFlag);
			const manager = ctx.sessionManager;
			const sessionId = manager.getSessionId();
			if (!manager.getSessionFile()) throw new Error("Cannot fork an ephemeral session; restart without --no-session.");
			if (!canFlush(manager)) throw new Error("This OMP version does not expose session flushing to extensions.");
			if (!ctx.isIdle() && !await ctx.ui.confirm(
				"Fork while a response is running?",
				"The child may omit the partial response. The parent will continue running here.",
			)) return;

			await manager.ensureOnDisk();
			await manager.flush();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("The current session is no longer persisted.");
			await access(sessionFile);
			if (ctx.sessionManager.getSessionId() !== sessionId) throw new Error("The session changed while preparing the fork; retry.");

			if (ctx.model) args.push("--model", `${ctx.model.provider}/${ctx.model.id}`);
			args.push("--thinking", pi.getThinkingLevel());
			const header = manager.getHeader();
			if (!cacheKeyPinned && header?.taskPromptCacheKey === undefined) {
				args.push("--prompt-cache-key", header?.providerPromptCacheKey ?? sessionId);
			}
			args.push("--cwd", ctx.cwd, "--session-dir", manager.getSessionDir(), "--fork", resolve(sessionFile));
			const rexArgs = [placement === "pane" ? "split" : "run", "-s", session];
			if (placement === "pane") rexArgs.push("-b", block, "--split=right");
			rexArgs.push("-c", ctx.cwd, "--shell=none", "--focus=false", "--json", "--", ...scopedCommand(pi, args));
			const result = await pi.exec("rex", rexArgs, { cwd: ctx.cwd, timeout: 15_000 });
			if (result.killed) throw new Error("Rex did not confirm creation before timeout; inspect Rex before retrying.");
			if (result.code !== 0) throw new Error(result.stderr.trim() || `Rex exited with status ${result.code}.`);
			const created = launchResult.parse(JSON.parse(result.stdout) as unknown);
			ctx.ui.notify(`Opened Rex ${placement} fork (${created.block_ids[0]}). This session continues here.`, "info");
		} catch (error) {
			pi.logger.error("Rex fork failed", { error });
			ctx.ui.notify(`Rex fork failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			launching = false;
		}
	}

	pi.registerCommand("rex-fork", {
		description: "Fork this conversation into a Rex pane or tab (default: pane)",
		getArgumentCompletions: (prefix) => ["pane", "tab", "window"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const placement = args.trim() || "pane";
			if (placement !== "pane" && placement !== "tab" && placement !== "window") {
				ctx.ui.notify("Usage: /rex-fork [pane|tab|window]", "error");
				return;
			}
			await fork(placement === "pane" ? "pane" : "tab", ctx);
		},
	});

	// Built-in names cannot be registered by extensions. Rewrite only explicit
	// placement requests in Rex; bare /fork and all non-Rex input stay native.
	pi.on("input", (event, ctx) => {
		if (ctx.mode !== "tui" || ctx.agent.kind !== "main" || !process.env.REX_SESSION || !process.env.REX_BLOCK) return;
		const match = /^\/fork\s+(pane|tab|window)\s*$/.exec(event.text.trim());
		if (match) return { text: `/rex-fork ${match[1]}` };
	});
}
