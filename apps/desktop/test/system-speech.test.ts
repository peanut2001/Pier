import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	setSpeechProvider,
	setSystemSpeechLanguage,
	setWhisperSettings,
	speechProvider,
	systemSpeech,
	whisperSettings,
} from "../src/lib/system-speech.ts";

const native = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({
	...native,
	Channel: class {
		constructor(public onmessage: (message: unknown) => void) {}
	},
}));

beforeEach(() => {
	vi.clearAllMocks();
	native.invoke.mockResolvedValue(undefined);
	native.isTauri.mockReturnValue(true);
	vi.stubGlobal("navigator", { platform: "MacIntel" });
	const storage = new Map<string, string>();
	vi.stubGlobal("localStorage", {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
	});
});
afterEach(() => vi.unstubAllGlobals());

describe("desktop system speech", () => {
	it("defaults to system speech on Mac and preserves an explicit service choice", () => {
		expect(speechProvider()).toBe("system");
		setSpeechProvider("service");
		expect(speechProvider()).toBe("service");
		setSpeechProvider("system");
		expect(speechProvider()).toBe("system");
	});

	it("uses the service in browsers and on unsupported platforms", () => {
		native.isTauri.mockReturnValue(false);
		expect(speechProvider()).toBe("service");
		native.isTauri.mockReturnValue(true);
		vi.stubGlobal("navigator", { platform: "unknown" });
		expect(speechProvider()).toBe("service");
	});

	it.each(["Win32", "Linux x86_64", "Linux aarch64"])(
		"uses local speech on %s and preserves the service choice",
		(platform) => {
			vi.stubGlobal("navigator", { platform });
			expect(speechProvider()).toBe("system");
			expect(systemSpeech.maxSeconds).toBe(120);
			setSpeechProvider("service");
			expect(speechProvider()).toBe("service");
		},
	);

	it("passes the chosen Windows language without Linux configuration", async () => {
		vi.stubGlobal("navigator", { platform: "Win32" });
		setSystemSpeechLanguage("zh-CN");
		await systemSpeech.prepare(new AbortController().signal);
		expect(native.invoke).toHaveBeenCalledExactlyOnceWith("system_speech_authorize", { language: "zh-CN" });
	});

	it("passes Linux executable/model paths as data and requires PCM audio", async () => {
		vi.stubGlobal("navigator", { platform: "Linux x86_64" });
		const settings = { executable: "/home/me/speech tools/whisper-cli", model: "/home/me/中文模型/ggml-base.bin" };
		setWhisperSettings(settings);
		setSystemSpeechLanguage("zh-CN");
		const operation = new AbortController();
		await systemSpeech.prepare(operation.signal);
		expect(native.invoke).toHaveBeenCalledWith("system_speech_authorize", { ...settings, language: "zh-CN" });
		const result = systemSpeech.transcribe({ data: "YQ==", mimeType: "audio/wav" }, operation.signal);
		const [, params] = native.invoke.mock.calls[1];
		expect(params).toMatchObject({ ...settings, language: "zh-CN" });
		params.output.onmessage({ text: "离线识别" });
		await expect(result).resolves.toBe("离线识别");
		await expect(systemSpeech.transcribe({ data: "YQ==", mimeType: "audio/mp4" }, operation.signal)).rejects.toThrow(
			"PCM WAV",
		);
	});

	it("recovers from invalid saved Linux settings", () => {
		localStorage.setItem("pier.speech.whisper", "broken json");
		expect(whisperSettings()).toEqual({ executable: "whisper-cli", model: "" });
		localStorage.setItem("pier.speech.whisper", '{"executable":4,"model":false}');
		expect(whisperSettings()).toEqual({ executable: "whisper-cli", model: "" });
	});

	it("returns native text and does not cancel a completed request when the operation is cleaned up", async () => {
		const operation = new AbortController();
		const result = systemSpeech.transcribe({ data: "YQ==", mimeType: "audio/mp4" }, operation.signal);
		const [, params] = native.invoke.mock.calls[0];
		params.output.onmessage({ text: "你好", error: null });
		await expect(result).resolves.toBe("你好");
		operation.abort();
		expect(native.invoke).toHaveBeenCalledTimes(1);
	});

	it("waits for job registration before cancelling a request aborted during IPC", async () => {
		let registered!: () => void;
		native.invoke.mockReturnValueOnce(new Promise<void>((resolve) => (registered = resolve)));
		const operation = new AbortController();
		const result = systemSpeech.transcribe({ data: "YQ==", mimeType: "audio/mp4" }, operation.signal);
		const [, params] = native.invoke.mock.calls[0];
		operation.abort();
		await expect(result).rejects.toThrow("已取消");
		expect(native.invoke).toHaveBeenCalledTimes(1);
		registered();
		await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith("system_speech_cancel", { id: params.id }));
		params.output.onmessage({ text: "late result" });
	});

	it("surfaces native errors and rejects incompatible audio before invoking Speech", async () => {
		const operation = new AbortController();
		native.invoke.mockRejectedValueOnce("系统语音识别不可用");
		await expect(systemSpeech.transcribe({ data: "YQ==", mimeType: "audio/mp4" }, operation.signal)).rejects.toThrow(
			"系统语音识别不可用",
		);
		await expect(systemSpeech.transcribe({ data: "YQ==", mimeType: "audio/webm" }, operation.signal)).rejects.toThrow(
			"MPEG-4",
		);
		expect(native.invoke).toHaveBeenCalledTimes(1);
	});
});
