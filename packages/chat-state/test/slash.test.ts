import type { ModelInfo, ThinkingLevel } from "@pier/protocol";
import { describe, expect, it, vi } from "vitest";
import {
	agentRuntimeLabel,
	BUILTIN_COMMANDS,
	builtinCommands,
	filterCommands,
	loadArgumentOptions,
	matchModel,
	mergeCommands,
	parseSlash,
	pickCommand,
	resolveSlash,
	runBuiltin,
	type SlashActions,
	type SlashTarget,
	slashMenu,
} from "../src/index.ts";

const models: ModelInfo[] = [
	{ provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5", reasoning: true, input: ["text"] },
	{ provider: "newapi", id: "claude-opus-5", name: "Claude Opus 5 (relay)", reasoning: true, input: ["text"] },
	{ provider: "openai", id: "gpt-6", name: "GPT-6", reasoning: false, input: ["text"] },
];

const commands = mergeCommands([
	{ name: "hello", description: "Say hello", source: "extension" },
	{ name: "review", description: "Review a file", argumentHint: "<file>", source: "prompt" },
	{ name: "skill:pdf-tools", description: "Work with PDFs", source: "skill" },
	{ name: "new", description: "Shadowed by the built-in", source: "extension" },
]);

function target(overrides: Partial<SlashTarget> = {}): SlashTarget {
	return {
		chat: { model: models[0], thinkingLevel: "medium", runState: "idle" },
		listModels: async () => ({ models }),
		setModel: vi.fn(async () => ({})),
		setThinking: vi.fn(async (level: ThinkingLevel) => ({ level })),
		compact: vi.fn(async () => ({})),
		forkPoints: async () => ({
			points: [
				{ entryId: "e1", text: "first" },
				{ entryId: "e2", text: "second\nline" },
			],
		}),
		rename: vi.fn(async () => ({})),
		reload: vi.fn(async () => ({})),
		...overrides,
	};
}

function actions(): SlashActions & { notes: string[] } {
	const notes: string[] = [];
	return {
		notes,
		newSession: vi.fn(() => true),
		fork: vi.fn(async () => true),
		notify: (level, message) => notes.push(`${level}: ${message}`),
	};
}

describe("slash command parsing", () => {
	it("parses commands and ignores paths", () => {
		expect(parseSlash("/model openai/gpt-6")).toEqual({ name: "model", args: "openai/gpt-6" });
		expect(parseSlash("  /skill:pdf-tools extract a.pdf \n")).toEqual({
			name: "skill:pdf-tools",
			args: "extract a.pdf",
		});
		expect(parseSlash("/new")).toEqual({ name: "new", args: "" });
		expect(parseSlash("/usr/bin is missing")).toBeUndefined();
		expect(parseSlash("//not a command")).toBeUndefined();
		expect(parseSlash("hello /new")).toBeUndefined();
		expect(parseSlash("/")).toBeUndefined();
	});

	it("merges host commands after the built-ins without shadowing them", () => {
		expect(commands.slice(0, BUILTIN_COMMANDS.length)).toEqual(BUILTIN_COMMANDS);
		expect(commands.filter((c) => c.name === "new")).toHaveLength(1);
		expect(commands.find((c) => c.name === "hello")).toMatchObject({ source: "extension", immediate: true });
		expect(commands.find((c) => c.name === "review")).toMatchObject({ immediate: false });
		expect(commands.find((c) => c.name === "skill:pdf-tools")).toMatchObject({ immediate: false });
	});

	it("resolves built-in, host, and unknown commands", () => {
		expect(resolveSlash("/compact keep todos", commands)).toEqual({
			kind: "builtin",
			name: "compact",
			args: "keep todos",
		});
		expect(resolveSlash("/review a.ts", commands)).toEqual({ kind: "host", command: "review" });
		expect(resolveSlash("/skills", commands)).toEqual({ kind: "unknown", name: "skills" });
		expect(resolveSlash("/skills", commands, false)).toEqual({ kind: "host", command: "skills" });
		expect(resolveSlash("fix the bug", commands)).toEqual({ kind: "message" });
	});
});

describe("slash command menu", () => {
	it("filters by prefix first, then substring and description", () => {
		expect(filterCommands(commands, "").map((c) => c.name)).toEqual(commands.map((c) => c.name));
		expect(filterCommands(commands, "pdf").map((c) => c.name)).toEqual(["skill:pdf-tools"]);
		expect(filterCommands(commands, "re").map((c) => c.name)).toEqual(["reload", "review"]);
		expect(filterCommands(commands, "ski")[0]?.name).toBe("skill:pdf-tools");
		expect(filterCommands(commands, "hello").map((c) => c.name)).toEqual(["hello"]);
		expect(filterCommands(commands, "file").map((c) => c.name)).toEqual(["review"]);
	});

	it("shows commands while typing the name and options for list arguments", () => {
		expect(slashMenu("/mo", commands)).toMatchObject({ kind: "commands", query: "mo", items: [{ name: "model" }] });
		expect(slashMenu("/model cla", commands)).toEqual({ kind: "arguments", command: "model", query: "cla" });
		expect(slashMenu("/thinking ", commands)).toEqual({ kind: "arguments", command: "thinking", query: "" });
		expect(slashMenu("/review a.ts", commands)).toBeUndefined();
		expect(slashMenu("/usr/", commands)).toBeUndefined();
		expect(slashMenu("/new\nmore", commands)).toBeUndefined();
		expect(slashMenu("hello", commands)).toBeUndefined();
	});

	it("runs immediate commands and completes the others", () => {
		const find = (name: string) => commands.find((c) => c.name === name) as (typeof commands)[number];
		expect(pickCommand(find("new"))).toEqual({ text: "/new", run: true });
		expect(pickCommand(find("model"))).toEqual({ text: "/model ", run: false });
		expect(pickCommand(find("new"), false)).toEqual({ text: "/new ", run: false });
		expect(pickCommand(find("skill:pdf-tools"))).toEqual({ text: "/skill:pdf-tools ", run: false });
	});

	it("loads argument options", async () => {
		const t = target();
		const modelOptions = await loadArgumentOptions(t, "model");
		expect(modelOptions[0]).toMatchObject({ value: "anthropic/claude-opus-5", selected: true });
		const levels = await loadArgumentOptions(t, "thinking");
		expect(levels.find((o) => o.selected)?.value).toBe("medium");
		const points = await loadArgumentOptions(t, "fork");
		expect(points.map((p) => p.value)).toEqual(["e2", "e1"]);
		expect(points[0]?.label).toBe("second line");
	});
});

describe("built-in commands", () => {
	it("matches models by provider/id, unique id, or name", () => {
		expect(matchModel(models, "openai/gpt-6")).toBe(models[2]);
		expect(matchModel(models, "GPT-6")).toBe(models[2]);
		expect(matchModel(models, "claude-opus-5")).toEqual({ error: expect.stringContaining("provider/model") });
		expect(matchModel(models, "Claude Opus 5 (relay)")).toBe(models[1]);
		expect(matchModel(models, "nope")).toEqual({ error: "找不到模型 nope" });
	});

	it("switches models and thinking levels", async () => {
		const t = target();
		const a = actions();
		expect(await runBuiltin(t, "model", "", a)).toEqual({ kind: "complete", text: "/model " });
		expect(await runBuiltin(t, "model", "newapi/claude-opus-5", a)).toEqual({ kind: "done" });
		expect(t.setModel).toHaveBeenCalledWith("newapi", "claude-opus-5");
		expect(await runBuiltin(t, "model", "nope", a)).toEqual({ kind: "failed" });
		expect(await runBuiltin(t, "thinking", "HIGH", a)).toEqual({ kind: "done" });
		expect(t.setThinking).toHaveBeenCalledWith("high");
		expect(await runBuiltin(t, "thinking", "turbo", a)).toEqual({ kind: "failed" });
		expect(a.notes).toHaveLength(2);
	});

	it("reports failed requests as failed", async () => {
		const t = target({ setModel: async () => undefined, rename: async () => undefined });
		const a = actions();
		expect(await runBuiltin(t, "model", "openai/gpt-6", a)).toEqual({ kind: "failed" });
		expect(await runBuiltin(t, "name", "New name", a)).toEqual({ kind: "failed" });
	});

	it("compacts, forks, renames, reloads, and opens new sessions", async () => {
		const t = target();
		const a = actions();
		expect(await runBuiltin(t, "compact", "keep todos", a)).toEqual({ kind: "done" });
		expect(t.compact).toHaveBeenCalledWith("keep todos");
		expect(await runBuiltin(t, "fork", "", a)).toEqual({ kind: "complete", text: "/fork " });
		expect(await runBuiltin(t, "fork", "e1", a)).toEqual({ kind: "done" });
		expect(a.fork).toHaveBeenCalledWith("e1");
		expect(await runBuiltin(t, "fork", "missing", a)).toEqual({ kind: "complete", text: "/fork " });
		expect(await runBuiltin(t, "name", "", a)).toEqual({ kind: "complete", text: "/name " });
		expect(await runBuiltin(t, "name", "Refactor", a)).toEqual({ kind: "done" });
		expect(t.rename).toHaveBeenCalledWith("Refactor");
		expect(await runBuiltin(t, "reload", "", a)).toEqual({ kind: "done" });
		expect(t.reload).toHaveBeenCalled();
		expect(await runBuiltin(t, "new", "", a)).toEqual({ kind: "done" });
		expect(a.newSession).toHaveBeenCalled();
	});

	it("refuses to compact or reload while the agent runs", async () => {
		const t = target({ chat: { model: models[0], thinkingLevel: "medium", runState: "streaming" } });
		const a = actions();
		expect(await runBuiltin(t, "compact", "", a)).toEqual({ kind: "failed" });
		expect(await runBuiltin(t, "reload", "", a)).toEqual({ kind: "failed" });
		expect(t.compact).not.toHaveBeenCalled();
		expect(t.reload).not.toHaveBeenCalled();
	});
});

describe("runtime capabilities", () => {
	const capabilities = {
		steer: true,
		followUp: true,
		compact: true,
		fork: false,
		rename: true,
		setModel: true,
		thinking: true,
		reload: false,
		images: true,
		piExtensions: false,
	};

	it("hides built-ins the runtime does not support", () => {
		expect(builtinCommands(capabilities).map((c) => c.name)).toEqual(["new", "model", "thinking", "compact", "name"]);
		expect(builtinCommands().map((c) => c.name)).toEqual(BUILTIN_COMMANDS.map((c) => c.name));
		// The runtime's own command of a hidden built-in's name stays.
		const merged = mergeCommands([{ name: "reload", source: "prompt" }], capabilities);
		expect(merged.find((c) => c.name === "reload")?.source).toBe("prompt");
	});

	it("names agent runtimes", () => {
		expect([undefined, "pi", "claude-code", "codex", "other"].map((id) => agentRuntimeLabel(id))).toEqual([
			"pi",
			"pi",
			"Claude Code",
			"Codex",
			"other",
		]);
	});
});
