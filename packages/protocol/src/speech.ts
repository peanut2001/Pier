import { z } from "zod";

export const MAX_SPEECH_BYTES = 4 * 1024 * 1024;
export const MAX_SPEECH_SECONDS = 120;

export const SpeechSettingsSchema = z.object({
	/** Full transcription URL, e.g. https://example.com/v1/audio/transcriptions. */
	url: z
		.string()
		.trim()
		.max(2048)
		.refine((value) => {
			if (!value) return true;
			try {
				const url = new URL(value);
				return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
			} catch {
				return false;
			}
		}, "请填写 HTTP(S) 接口地址，不含用户名、密码、查询参数或片段"),
	model: z.string().trim().min(1).max(256),
	/** ISO-639-1 language, or empty for automatic detection. */
	language: z.string().regex(/^$|^[a-z]{2}$/),
});
export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>;
export type SpeechStatus = SpeechSettings & { hasApiKey: boolean; configured: boolean };

export const SpeechAudioSchema = z.object({
	id: z.string().min(1).max(128),
	data: z
		.string()
		.min(4)
		.max(Math.ceil(MAX_SPEECH_BYTES / 3) * 4)
		.regex(/^[A-Za-z0-9+/]*={0,2}$/)
		.refine((value) => value.length % 4 === 0, "Invalid base64 audio"),
	mimeType: z.enum(["audio/webm", "audio/mp4", "audio/wav", "audio/ogg", "audio/mpeg"]),
});
export type SpeechAudio = z.infer<typeof SpeechAudioSchema>;

export const SpeechMethodSchemas = {
	"speech.status": z.object({}).optional(),
	"speech.configure": SpeechSettingsSchema.extend({
		/** Omit to keep the key; empty removes it. Changing URL clears an omitted key. */
		apiKey: z
			.string()
			.trim()
			.max(4096)
			.regex(/^[^\r\n]*$/)
			.optional(),
	}),
	"speech.transcribe": SpeechAudioSchema,
	"speech.cancel": z.object({ id: z.string().min(1).max(128) }),
};
