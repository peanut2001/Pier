// A small stand-in for `codex app-server` (newline-delimited JSON-RPC over stdio) used by the
// Codex runtime tests. State lives in memory; rollout files are created in FAKE_CODEX_DIR.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const dir = process.env.FAKE_CODEX_DIR ?? process.cwd();
const threads = new Map();
const pendingServer = new Map();
let nextServerId = 1;
let seq = 0;
const id = (prefix) => `${prefix}-${++seq}`;
const now = () => Math.floor(Date.now() / 1000);

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
const notify = (method, params) => send({ method, params });
function ask(method, params) {
	const requestId = nextServerId++;
	send({ id: requestId, method, params });
	return new Promise((resolve) => pendingServer.set(requestId, resolve));
}

function threadView(thread, withTurns = false) {
	const { turns, archived, ...rest } = thread;
	return { ...rest, turns: withTurns ? turns : [] };
}

function newThread(cwd, extra = {}) {
	const threadId = id("thread");
	const path = join(dir, `rollout-${threadId}.jsonl`);
	writeFileSync(path, "");
	const thread = {
		id: threadId,
		sessionId: threadId,
		forkedFromId: null,
		preview: "",
		ephemeral: false,
		modelProvider: "openai",
		model: "gpt-test",
		reasoningEffort: null,
		createdAt: now(),
		updatedAt: now(),
		status: { type: "idle" },
		path,
		cwd,
		name: null,
		turns: [],
		archived: false,
		...extra,
	};
	threads.set(threadId, thread);
	return thread;
}

const MODELS = [
	{
		id: "gpt-test",
		model: "gpt-test",
		displayName: "GPT Test",
		hidden: false,
		supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }],
		defaultReasoningEffort: "medium",
		inputModalities: ["text", "image"],
		isDefault: true,
	},
	{
		id: "gpt-mini",
		model: "gpt-mini",
		displayName: "GPT Mini",
		hidden: false,
		supportedReasoningEfforts: [{ reasoningEffort: "low" }],
		defaultReasoningEffort: "low",
		inputModalities: ["text"],
		isDefault: false,
	},
];

const active = new Map();

async function runTurn(thread, turn, text) {
	const threadId = thread.id;
	const turnId = turn.id;
	const cancelled = () => active.get(threadId)?.interrupted === true;
	const complete = (item) => {
		turn.items.push(item);
		notify("item/completed", { threadId, turnId, item, completedAtMs: Date.now() });
	};
	notify("turn/started", { threadId, turn: { ...turn, items: [] } });
	if (text.includes("run")) {
		const item = {
			type: "commandExecution",
			id: id("cmd"),
			command: "npm install",
			cwd: thread.cwd,
			status: "inProgress",
			commandActions: [],
			aggregatedOutput: null,
			exitCode: null,
			durationMs: null,
		};
		notify("item/started", { threadId, turnId, item, startedAtMs: Date.now() });
		const answer = await ask("item/commandExecution/requestApproval", {
			threadId,
			turnId,
			itemId: item.id,
			command: item.command,
			cwd: thread.cwd,
			reason: "needs network",
		});
		if (answer?.decision === "accept" || answer?.decision === "acceptForSession") {
			notify("item/commandExecution/outputDelta", { threadId, turnId, itemId: item.id, delta: "hi\n" });
			complete({ ...item, status: "completed", exitCode: 0, aggregatedOutput: "hi\n" });
		} else {
			complete({ ...item, status: "declined" });
		}
	}
	if (text.includes("wait")) {
		await new Promise((resolve) => {
			const timer = setInterval(() => {
				if (cancelled() || active.get(threadId)?.release) {
					clearInterval(timer);
					resolve();
				}
			}, 10);
		});
	}
	if (cancelled()) {
		turn.status = "interrupted";
	} else {
		const steered = active.get(threadId)?.steered ?? [];
		for (const message of steered) {
			const userItem = { type: "userMessage", id: id("user"), clientId: message.clientId, content: message.input };
			notify("item/started", { threadId, turnId, item: userItem, startedAtMs: Date.now() });
			complete(userItem);
		}
		const reasoning = { type: "reasoning", id: id("rs"), summary: [], content: [] };
		notify("item/started", { threadId, turnId, item: reasoning, startedAtMs: Date.now() });
		notify("item/reasoning/summaryTextDelta", {
			threadId,
			turnId,
			itemId: reasoning.id,
			delta: "Thinking",
			summaryIndex: 0,
		});
		complete({ ...reasoning, summary: ["Thinking"] });
		const message = { type: "agentMessage", id: id("msg"), text: "", phase: null };
		notify("item/started", { threadId, turnId, item: message, startedAtMs: Date.now() });
		const reply = `Reply to ${text}${steered.length ? ` + ${steered.length} steer` : ""}`;
		for (const chunk of reply.match(/.{1,5}/g) ?? []) {
			notify("item/agentMessage/delta", { threadId, turnId, itemId: message.id, delta: chunk });
		}
		complete({ ...message, text: reply });
		notify("thread/tokenUsage/updated", {
			threadId,
			turnId,
			tokenUsage: {
				total: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 },
				last: { totalTokens: 30, inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 0 },
				modelContextWindow: 100000,
			},
		});
		turn.status = "completed";
	}
	active.delete(threadId);
	thread.updatedAt = now();
	notify("turn/completed", { threadId, turn });
}

const handlers = {
	initialize: () => ({ userAgent: "fake", codexHome: dir, platformFamily: "unix", platformOs: "linux" }),
	"model/list": () => ({ data: MODELS, nextCursor: null }),
	"thread/start": (params) => {
		const thread = newThread(params.cwd);
		notify("thread/started", { thread: threadView(thread) });
		return { thread: threadView(thread), model: "gpt-test", modelProvider: "openai", reasoningEffort: null };
	},
	"thread/list": (params) => ({
		data: [...threads.values()]
			.filter((t) => !t.archived && t.cwd === params.cwd && t.turns.length > 0)
			.map((t) => threadView(t)),
		nextCursor: null,
	}),
	"thread/resume": (params) => {
		const thread = threads.get(params.threadId);
		if (!thread) throw new Error("no such thread");
		return { thread: threadView(thread), model: thread.model, reasoningEffort: thread.reasoningEffort };
	},
	"thread/turns/list": (params) => ({ data: threads.get(params.threadId)?.turns ?? [], nextCursor: null }),
	"thread/fork": (params) => {
		const source = threads.get(params.threadId);
		const end = source.turns.findIndex((t) => t.id === params.lastTurnId);
		const thread = newThread(source.cwd, {
			forkedFromId: source.id,
			preview: source.preview,
			turns: structuredClone(source.turns.slice(0, end + 1)),
		});
		return { thread: threadView(thread), model: thread.model, reasoningEffort: null };
	},
	"thread/name/set": (params) => {
		const thread = threads.get(params.threadId);
		thread.name = params.name;
		notify("thread/name/updated", { threadId: thread.id, threadName: params.name });
		return {};
	},
	"thread/archive": (params) => {
		threads.get(params.threadId).archived = true;
		return {};
	},
	"thread/unsubscribe": () => ({}),
	"thread/compact/start": (params) => {
		setTimeout(() => notify("thread/compacted", { threadId: params.threadId, turnId: "compact" }), 10);
		return {};
	},
	"turn/start": (params) => {
		const thread = threads.get(params.threadId);
		const text = params.input.find((i) => i.type === "text")?.text ?? "";
		if (!thread.preview) thread.preview = text;
		const userItem = {
			type: "userMessage",
			id: id("user"),
			clientId: params.clientUserMessageId,
			content: params.input,
		};
		const turn = { id: id("turn"), items: [userItem], status: "inProgress", error: null, startedAt: now() };
		thread.turns.push(turn);
		thread.lastTurnParams = params;
		active.set(thread.id, { turnId: turn.id, steered: [] });
		setTimeout(() => {
			notify("item/started", { threadId: thread.id, turnId: turn.id, item: userItem, startedAtMs: Date.now() });
			void runTurn(thread, turn, text);
		}, 5);
		return { turn: { ...turn, items: [] } };
	},
	"turn/steer": (params) => {
		const run = active.get(params.threadId);
		if (!run || run.turnId !== params.expectedTurnId) throw new Error("no active turn");
		run.steered.push({ clientId: params.clientUserMessageId, input: params.input });
		run.release = true;
		return { turnId: run.turnId };
	},
	"turn/interrupt": (params) => {
		const run = active.get(params.threadId);
		if (run) run.interrupted = true;
		return {};
	},
	// Test helper: what the last turn/start asked for.
	"fake/lastTurn": (params) => threads.get(params.threadId)?.lastTurnParams ?? null,
};

createInterface({ input: process.stdin }).on("line", async (line) => {
	if (!line.trim()) return;
	const message = JSON.parse(line);
	if (message.method && message.id !== undefined) {
		const handler = handlers[message.method];
		try {
			if (!handler) throw new Error(`unknown method ${message.method}`);
			send({ id: message.id, result: await handler(message.params ?? {}) });
		} catch (error) {
			send({ id: message.id, error: { code: -32000, message: error.message } });
		}
	} else if (message.id !== undefined) {
		pendingServer.get(message.id)?.(message.result);
		pendingServer.delete(message.id);
	}
});
