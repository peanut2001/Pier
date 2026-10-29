import { existsSync, readFileSync } from "node:fs";
import {
	MAX_SPEECH_BYTES,
	PierProtocolError,
	type SpeechAudio,
	SpeechMethodSchemas,
	type SpeechStatus,
} from "@pier/protocol";
import type { z } from "zod";
import { writePrivateFile } from "./config.ts";

type Settings = z.infer<(typeof SpeechMethodSchemas)["speech.configure"]>;
const EXTENSIONS = {
	"audio/webm": "webm",
	"audio/mp4": "m4a",
	"audio/wav": "wav",
	"audio/ogg": "ogg",
	"audio/mpeg": "mp3",
};

/** Audio stays in memory; credentials never return to clients or enter the audit log. */
export class SpeechService {
	private settings: Settings;
	private readonly pending = new Map<string, { id: string; controller: AbortController }>();

	constructor(
		private readonly file: string,
		private readonly fetcher: typeof fetch = fetch,
	) {
		this.settings = existsSync(file)
			? SpeechMethodSchemas["speech.configure"].parse(JSON.parse(readFileSync(file, "utf8")))
			: { url: "", model: "whisper-1", language: "" };
	}

	status(): SpeechStatus {
		const { url, model, language, apiKey } = this.settings;
		return { url, model, language, hasApiKey: !!apiKey, configured: !!url };
	}

	configure(input: Settings): SpeechStatus {
		const next = SpeechMethodSchemas["speech.configure"].parse(input);
		if (next.apiKey === undefined && next.url === this.settings.url) next.apiKey = this.settings.apiKey;
		writePrivateFile(this.file, `${JSON.stringify(next, null, 2)}\n`);
		this.settings = next;
		return this.status();
	}

	cancel(connectionId: string, id?: string): boolean {
		const request = this.pending.get(connectionId);
		if (!request || (id !== undefined && request.id !== id)) return false;
		request.controller.abort();
		return true;
	}

	shutdown(): void {
		for (const { controller } of this.pending.values()) controller.abort();
	}

	async transcribe(connectionId: string, audio: SpeechAudio): Promise<{ text: string }> {
		const { url, model, language, apiKey } = this.settings;
		if (!url) throw new PierProtocolError("BAD_REQUEST", "请先配置语音输入的服务地址与模型");
		if (this.pending.has(connectionId) || this.pending.size >= 4) {
			throw new PierProtocolError("BAD_REQUEST", "语音识别正在进行，请稍后重试");
		}
		const bytes = Buffer.from(audio.data, "base64");
		if (!bytes.length || bytes.length > MAX_SPEECH_BYTES)
			throw new PierProtocolError("BAD_REQUEST", "录音为空或超过 4 MiB");
		const form = new FormData();
		form.set("file", new Blob([bytes], { type: audio.mimeType }), `speech.${EXTENSIONS[audio.mimeType]}`);
		form.set("model", model);
		form.set("response_format", "json");
		if (language) form.set("language", language);
		const controller = new AbortController();
		this.pending.set(connectionId, { id: audio.id, controller });
		const timeout = setTimeout(() => controller.abort(), 60_000);
		try {
			const response = await this.fetcher(url, {
				method: "POST",
				body: form,
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
				signal: controller.signal,
				redirect: "error",
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new PierProtocolError(
					"BAD_REQUEST",
					`语音识别服务返回 HTTP ${response.status}，请检查地址、模型和 API Key`,
				);
			}
			const reader = response.body?.getReader();
			if (!reader) throw new Error("Empty response");
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 1024 * 1024) {
					await reader.cancel();
					throw new Error("Response too large");
				}
				chunks.push(value);
			}
			const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown } | null;
			if (typeof result?.text !== "string") throw new Error("Invalid response");
			return { text: result.text.trim() };
		} catch (error) {
			if (error instanceof PierProtocolError) throw error;
			// Provider bodies and transport errors may echo credentials or audio; do not forward them.
			throw new PierProtocolError(
				"BAD_REQUEST",
				controller.signal.aborted ? "语音识别已取消或超时，请重试" : "语音识别失败，请检查服务连接和返回格式",
			);
		} finally {
			clearTimeout(timeout);
			this.pending.delete(connectionId);
		}
	}
}
