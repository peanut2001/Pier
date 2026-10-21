import type { DeviceSpeech } from "@pier/chat-state";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";

export type SpeechProvider = "system" | "service";
const PROVIDER_KEY = "pier.speech.provider";
const LANGUAGE_KEY = "pier.speech.systemLanguage";
const listeners = new Set<() => void>();

export function supportsSystemSpeech(): boolean {
	return isTauri() && typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
}

export function speechProvider(): SpeechProvider {
	return supportsSystemSpeech() && localStorage.getItem(PROVIDER_KEY) !== "service" ? "system" : "service";
}

export function setSpeechProvider(provider: SpeechProvider): void {
	localStorage.setItem(PROVIDER_KEY, provider);
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useSpeechProvider(): SpeechProvider {
	return useSyncExternalStore(subscribe, speechProvider);
}

export function systemSpeechLanguage(): string {
	return localStorage.getItem(LANGUAGE_KEY) ?? "";
}

export function setSystemSpeechLanguage(language: string): void {
	localStorage.setItem(LANGUAGE_KEY, language);
}

export const systemSpeech: DeviceSpeech = {
	// Apple's online recognition limits a request to one minute.
	maxSeconds: 60,
	async prepare(signal) {
		if (signal.aborted) return;
		await invoke("system_speech_authorize").catch((error: unknown) => {
			throw new Error(String(error));
		});
	},
	async transcribe(clip, signal) {
		if (signal.aborted) throw new Error("语音输入已取消");
		if (clip.mimeType !== "audio/mp4") throw new Error("系统语音识别需要 MPEG-4 录音，请更新 macOS 后重试");
		const id = crypto.randomUUID();
		return new Promise<string>((resolve, reject) => {
			const finish = (text: string, error?: string | null) => {
				signal.removeEventListener("abort", abort);
				if (error) reject(new Error(error));
				else resolve(text);
			};
			const output = new Channel<{ text: string; error?: string | null }>(({ text, error }) => finish(text, error));
			const started = invoke<void>("system_speech_transcribe", {
				id,
				data: clip.data,
				language: systemSpeechLanguage(),
				output,
			});
			const abort = () => {
				finish("", "语音输入已取消");
				// Wait for the native job to be registered before cancelling, including rapid session switches.
				void started.then(() => invoke("system_speech_cancel", { id })).catch(() => undefined);
			};
			signal.addEventListener("abort", abort, { once: true });
			void started.catch((error: unknown) => finish("", String(error)));
		});
	},
};
