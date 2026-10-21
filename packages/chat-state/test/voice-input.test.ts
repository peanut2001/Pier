import type { PierClient } from "@pier/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendDictation, VoiceInput, type VoiceRecording } from "../src/voice-input.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function setup() {
	const request = vi.fn(async (method: string, _params?: unknown) =>
		method === "speech.status" ? { configured: true } : { text: "你好，Pier" },
	);
	const client = { state: "open", host: { protocolVersion: "1.46" }, request } as unknown as PierClient;
	const recording: VoiceRecording = {
		stop: vi.fn(async () => ({ data: "YQ==", mimeType: "audio/mp4" as const })),
		cancel: vi.fn(async () => {}),
	};
	const record = vi.fn(async (_signal: AbortSignal) => recording);
	const onText = vi.fn();
	const onError = vi.fn();
	const voice = new VoiceInput({ client, record, onText, onError, onPhase: vi.fn() });
	return { voice, client, record, recording, request, onText, onError };
}

afterEach(() => vi.useRealTimers());

describe("voice input lifecycle", () => {
	it("stops once and adds recognized text only after the user stops recording", async () => {
		const t = setup();
		await t.voice.start();
		await t.voice.start();
		expect(t.record).toHaveBeenCalledTimes(1);
		expect(t.voice.phase).toBe("recording");
		expect(t.onText).not.toHaveBeenCalled();
		await Promise.all([t.voice.stop(), t.voice.stop()]);
		expect(t.recording.stop).toHaveBeenCalledTimes(1);
		expect(t.onText).toHaveBeenCalledExactlyOnceWith("你好，Pier");
		expect(t.voice.phase).toBe("idle");
	});

	it("rejects an old Host before asking for the microphone", async () => {
		const t = setup();
		Object.assign(t.client, { host: { protocolVersion: "1.45" } });
		await t.voice.start();
		expect(t.record).not.toHaveBeenCalled();
		expect(t.onError).toHaveBeenCalledWith(expect.stringContaining("1.46"));
		expect(t.voice.phase).toBe("idle");
	});

	it("does not record without a configured provider", async () => {
		const t = setup();
		t.request.mockResolvedValueOnce({ configured: false });
		await t.voice.start();
		expect(t.record).not.toHaveBeenCalled();
		expect(t.onError).toHaveBeenCalledWith(expect.stringContaining("语音设置"));
	});

	it("waits for a pending microphone permission to settle and releases it after cancel", async () => {
		const t = setup();
		const permission = deferred<VoiceRecording>();
		t.record.mockReturnValueOnce(permission.promise);
		const starting = t.voice.start();
		await vi.waitFor(() => expect(t.record).toHaveBeenCalled());
		const cancelling = t.voice.cancel();
		expect(t.voice.phase).toBe("cancelling");
		await t.voice.start();
		expect(t.record).toHaveBeenCalledTimes(1);
		permission.resolve(t.recording);
		await Promise.all([starting, cancelling]);
		expect(t.recording.cancel).toHaveBeenCalled();
		expect(t.voice.phase).toBe("idle");
		expect(t.request).not.toHaveBeenCalledWith("speech.transcribe", expect.anything(), expect.anything());
	});

	it("ignores late transcriptions after a session switch and cancels the Host request", async () => {
		const t = setup();
		await t.voice.start();
		const result = deferred<{ text: string }>();
		t.request.mockReturnValueOnce(result.promise);
		const stopping = t.voice.stop();
		await vi.waitFor(() =>
			expect(t.request).toHaveBeenCalledWith("speech.transcribe", expect.anything(), expect.anything()),
		);
		t.voice.dispose();
		result.resolve({ text: "stale result" });
		await stopping;
		expect(t.onText).not.toHaveBeenCalled();
		expect(t.onError).not.toHaveBeenCalled();
		expect(t.request).toHaveBeenCalledWith("speech.cancel", { id: expect.any(String) });
	});

	it("keeps a new recording active when a cancelled request fails late", async () => {
		const t = setup();
		await t.voice.start();
		const old = deferred<{ text: string }>();
		t.request.mockReturnValueOnce(old.promise);
		const stopping = t.voice.stop();
		await vi.waitFor(() => expect(t.voice.phase).toBe("transcribing"));
		await t.voice.cancel();
		await t.voice.start();
		old.reject(new Error("late failure"));
		await stopping;
		expect(t.voice.phase).toBe("recording");
		expect(t.onError).not.toHaveBeenCalled();
		await t.voice.cancel();
	});

	it("stops recording after two minutes", async () => {
		vi.useFakeTimers();
		const t = setup();
		await t.voice.start();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(t.recording.stop).toHaveBeenCalledOnce();
		expect(t.onText).toHaveBeenCalledOnce();
	});

	it("preserves drafts and file references, and strips injected chip markers", () => {
		expect(appendDictation("已有文字\uE000src/main.ts\uE001", "新内容")).toBe(
			"已有文字\uE000src/main.ts\uE001\n新内容",
		);
		expect(appendDictation("typing\n", "  hello\uE000world\uE001  ")).toBe("typing\nhelloworld");
		expect(appendDictation("keep", "  ")).toBe("keep");
	});
});
