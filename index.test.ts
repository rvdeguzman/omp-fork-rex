import { describe, expect, test } from "bun:test";
import { startupFlags } from "./index";

const noExtensionFlag = (_name: string): undefined => undefined;

describe("fork startup arguments", () => {
	test("drops original prompts and session selectors without dropping configuration", () => {
		const result = startupFlags([
			"launch", "--profile", "work", "--resume", "old-session", "--goal=old objective",
			"--config", "/tmp/config with spaces.yml", "--cwd=/old/path", "--model", "old/model",
			"--thinking=low", "--session-dir", "/old/sessions", "--extension", "/tmp/extension with spaces.ts",
			"--no-lsp", "@private-file.txt", "Never submit this original prompt again",
		], noExtensionFlag);
		expect(result.args).toEqual(["--profile", "work", "--extension", "/tmp/extension with spaces.ts", "--no-lsp"]);
	});

	test("distinguishes an API-key flag from literal prompt content that looks like one", () => {
		expect(startupFlags(["--system-prompt", "--api-key", "--no-title"], noExtensionFlag).args)
			.toEqual(["--system-prompt", "--api-key", "--no-title"]);
		for (const argv of [["--api-key", "secret"], ["--api-key=secret"]]) {
			expect(() => startupFlags(argv, noExtensionFlag)).toThrow("Cannot forward --api-key safely");
		}
	});

	test("preserves exact string values and pinned cache identity", () => {
		const prompt = "$(touch /tmp/should-not-exist); 'quoted'\nsecond line";
		const result = startupFlags(["--append-system-prompt", prompt, "--prompt-cache-key=original-cache"], noExtensionFlag);
		expect(result).toEqual({
			args: ["--append-system-prompt", prompt, "--prompt-cache-key=original-cache"],
			cacheKeyPinned: true,
		});
	});

	test("uses extension flag types so a boolean does not consume and replay a prompt", () => {
		const flags: Record<string, string | boolean> = { plan: true, custom: "project" };
		const result = startupFlags(["--plan", "Original prompt", "--custom", "project"], (name) => flags[name]);
		expect(result.args).toEqual(["--plan", "--custom", "project"]);
	});

	test("never interprets literal arguments after the end-of-options marker", () => {
		expect(startupFlags(["--no-title", "--", "--api-key=literal text", "--model", "wrong/model"], noExtensionFlag).args)
			.toEqual(["--no-title"]);
	});

	test("refuses unknown flags instead of risking replay of a positional prompt", () => {
		expect(() => startupFlags(["--future-flag", "Original prompt"], noExtensionFlag)).toThrow("Unsupported startup flag");
		expect(() => startupFlags(["--extension"], noExtensionFlag)).toThrow("Missing value");
	});
});
