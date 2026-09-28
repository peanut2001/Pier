import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PierClient, type PierClientOptions } from "@pier/client";
import type { EventFrame } from "@pier/protocol";
import { startLocalGateway } from "../src/gateway/local-gateway.ts";
import { PierHost, type PierHostOptions } from "../src/host.ts";
import { PiEnvironment } from "../src/pi/environment.ts";

export { fauxAssistantMessage, fauxText, fauxToolCall };
export type FauxStep = Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0][number];

export const TOKEN = "test-token-0123456789abcdef";

export interface TestHost {
	root: string;
	workspaceDir: string;
	host: PierHost;
	url: string;
	faux: ReturnType<typeof fauxProvider>;
	connect(options?: Partial<PierClientOptions>): Promise<PierClient>;
	close(): Promise<void>;
}

export async function startTestHost(
	options: Partial<Omit<PierHostOptions, "env" | "localToken">> & { tokensPerSecond?: number } = {},
): Promise<TestHost> {
	const root = mkdtempSync(join(tmpdir(), "pier-it-"));
	const workspaceDir = join(root, "workspace");
	mkdirSync(workspaceDir, { recursive: true });

	const faux = fauxProvider({
		provider: "faux",
		models: [
			{ id: "faux-1", name: "Faux One", reasoning: true },
			{ id: "faux-2", name: "Faux Two" },
		],
		...(options.tokensPerSecond ? { tokensPerSecond: options.tokensPerSecond, tokenSize: { min: 1, max: 1 } } : {}),
	});
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	const env = await PiEnvironment.create({
		agentDir: join(root, "agent"),
		modelRuntime,
		settingsManager: () => SettingsManager.inMemory({ defaultProvider: "faux", defaultModel: "faux-1" }),
		sessionDir: join(root, "sessions"),
		isolated: true,
	});
	const { tokensPerSecond: _ignored, ...hostOptions } = options;
	const host = await PierHost.create({ pierDir: join(root, "pier"), env, localToken: TOKEN, ...hostOptions });
	const gateway = await startLocalGateway(host);
	const clients: PierClient[] = [];

	return {
		root,
		workspaceDir,
		host,
		url: gateway.url,
		faux,
		async connect(extra = {}) {
			const client = new PierClient({
				url: gateway.url,
				token: TOKEN,
				client: { name: "test", version: "0.0.0" },
				reconnect: { initialDelayMs: 20, maxDelayMs: 60 },
				...extra,
			});
			await client.connect();
			clients.push(client);
			return client;
		},
		async close() {
			for (const client of clients) client.close();
			await host.shutdown();
			await gateway.close();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/** Collects frames and lets tests await specific events. */
export class Recorder {
	readonly frames: EventFrame[] = [];
	private waiters: Array<{ from: number; predicate: (f: EventFrame) => boolean; resolve: (f: EventFrame) => void }> =
		[];

	readonly handler = (frame: EventFrame): void => {
		this.frames.push(frame);
		const index = this.frames.length - 1;
		this.waiters = this.waiters.filter((w) => {
			if (index >= w.from && w.predicate(frame)) {
				w.resolve(frame);
				return false;
			}
			return true;
		});
	};

	mark(): number {
		return this.frames.length;
	}

	types(from = 0): string[] {
		return this.frames.slice(from).map((f) => f.event.type);
	}

	waitFor(predicate: (f: EventFrame) => boolean, from = 0, timeoutMs = 5000): Promise<EventFrame> {
		const existing = this.frames.slice(from).find(predicate);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new Error(`Timed out waiting for event; saw: ${this.types(from).join(", ")}`));
			}, timeoutMs);
			this.waiters.push({
				from,
				predicate,
				resolve: (frame) => {
					clearTimeout(timer);
					resolve(frame);
				},
			});
		});
	}

	waitForType(type: string, from = 0, timeoutMs = 5000): Promise<EventFrame> {
		return this.waitFor((f) => f.event.type === type, from, timeoutMs);
	}

	text(from = 0): string {
		return this.frames
			.slice(from)
			.filter((f) => f.event.type === "message_update")
			.map((f) => f.event.assistantMessageEvent as { type: string; delta?: string })
			.filter((e) => e.type === "text_delta")
			.map((e) => e.delta ?? "")
			.join("");
	}
}

/** Text of the last tool result the model saw, for asserting blocked/allowed tool calls. */
export function lastToolResultText(context: { messages: unknown[] }): string {
	const messages = context.messages as Array<{ role: string; content?: Array<{ type: string; text?: string }> }>;
	const result = [...messages].reverse().find((m) => m.role === "toolResult");
	return result?.content?.map((c) => c.text ?? "").join("") ?? "";
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

export type { AssistantMessage };
