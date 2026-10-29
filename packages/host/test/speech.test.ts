import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SPEECH_BYTES, SpeechAudioSchema, SpeechMethodSchemas } from "@pier/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechService } from "../src/speech.ts";
import { startTestHost } from "./helpers.ts";

const audio = { id: "clip", data: "YWJj", mimeType: "audio/webm" as const };
const settings = {
	url: "https://speech.example/v1/audio/transcriptions",
	model: "whisper-1",
	language: "zh",
	apiKey: "test-secret",
};
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pier-speech-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	vi.useRealTimers();
});

describe("speech service", () => {
	it("stores private settings, redacts the key and clears it when switching services", () => {
		const file = join(root, "speech.json");
		const service = new SpeechService(file);
		expect(service.status().configured).toBe(false);
		expect(service.configure(settings)).toEqual({
			url: settings.url,
			model: settings.model,
			language: "zh",
			hasApiKey: true,
			configured: true,
		});
		expect(new SpeechService(file).status()).toEqual(service.status());
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		service.configure({ url: settings.url, model: "another-model", language: "" });
		expect(JSON.parse(readFileSync(file, "utf8")).apiKey).toBe("test-secret");
		service.configure({ url: "https://other.example/transcribe", model: "another-model", language: "" });
		expect(service.status().hasApiKey).toBe(false);
		service.configure(settings);
		expect(service.configure({ ...settings, apiKey: "" }).hasApiKey).toBe(false);
	});

	it("uploads the actual audio as multipart and returns only text", async () => {
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			expect(init?.headers).toEqual({ Authorization: "Bearer test-secret" });
			expect(init?.redirect).toBe("error");
			const form = init?.body as FormData;
			expect(form.get("model")).toBe("whisper-1");
			expect(form.get("language")).toBe("zh");
			expect(form.get("response_format")).toBe("json");
			const file = form.get("file") as File;
			expect(file.name).toBe("speech.webm");
			expect(file.type).toBe("audio/webm");
			expect(await file.text()).toBe("abc");
			return Response.json({ text: "  中文 input  ", private: "hidden" });
		});
		const service = new SpeechService(join(root, "speech.json"), fetcher);
		service.configure(settings);
		expect(await service.transcribe("connection", audio)).toEqual({ text: "中文 input" });
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("does not leak provider response bodies or fetch errors", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("test-secret", { status: 401 }))
			.mockRejectedValueOnce(new Error("test-secret"));
		const service = new SpeechService(join(root, "speech.json"), fetcher);
		service.configure(settings);
		await expect(service.transcribe("a", audio)).rejects.toThrow("HTTP 401");
		await expect(service.transcribe("a", audio)).rejects.toThrow("请检查服务连接和返回格式");
	});

	it("scopes cancellation to a connection and enforces concurrency", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async (_url, init) =>
				new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
		);
		const service = new SpeechService(join(root, "speech.json"), fetcher);
		service.configure(settings);
		const request = service.transcribe("owner", audio);
		const rejected = expect(request).rejects.toThrow("取消或超时");
		expect(service.cancel("other", "clip")).toBe(false);
		expect(service.cancel("owner", "other-id")).toBe(false);
		await expect(service.transcribe("owner", audio)).rejects.toThrow("正在进行");
		expect(service.cancel("owner", "clip")).toBe(true);
		await rejected;
		expect(service.cancel("owner", "clip")).toBe(false);
	});

	it("times out a stalled provider", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn<typeof fetch>(
			async (_url, init) =>
				new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout")))),
		);
		const service = new SpeechService(join(root, "speech.json"), fetcher);
		service.configure(settings);
		const rejected = expect(service.transcribe("a", audio)).rejects.toThrow("超时");
		await vi.advanceTimersByTimeAsync(60_000);
		await rejected;
	});

	it("rejects invalid and oversized payloads and boundedly reads responses", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)))
			.mockResolvedValueOnce(Response.json({ text: 1 }));
		const service = new SpeechService(join(root, "speech.json"), fetcher);
		service.configure(settings);
		await expect(
			service.transcribe("a", { ...audio, data: Buffer.alloc(MAX_SPEECH_BYTES + 1).toString("base64") }),
		).rejects.toThrow("超过");
		expect(fetcher).not.toHaveBeenCalled();
		await expect(service.transcribe("a", audio)).rejects.toThrow("返回格式");
		await expect(service.transcribe("a", audio)).rejects.toThrow("返回格式");
		expect(SpeechAudioSchema.safeParse({ ...audio, data: "bad!" }).success).toBe(false);
		expect(
			SpeechAudioSchema.safeParse({ ...audio, data: Buffer.alloc(MAX_SPEECH_BYTES).toString("base64") }).success,
		).toBe(true);
		for (const url of ["file:///tmp/audio", "https://user:pass@example.com/", "https://example.com/?key=secret"]) {
			expect(SpeechMethodSchemas["speech.configure"].safeParse({ ...settings, url }).success).toBe(false);
		}
	});

	it("exposes settings through the authenticated Host protocol without leaking the saved key", async () => {
		const host = await startTestHost();
		try {
			const client = await host.connect();
			expect((await client.request("speech.status")).configured).toBe(false);
			const status = await client.request("speech.configure", settings);
			expect(status.hasApiKey).toBe(true);
			expect(JSON.stringify(status)).not.toContain("test-secret");
			expect(await client.request("speech.status")).toEqual(status);
			expect(await client.request("speech.cancel", { id: "none" })).toEqual({ cancelled: false });
		} finally {
			await host.close();
		}
	});
});
