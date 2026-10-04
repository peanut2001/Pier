/**
 * Structural types for the pi `AgentMessage` values that travel over the wire.
 *
 * The protocol package deliberately does not depend on the pi SDK (it must run in
 * React Native), so these mirror the fields clients render. Unknown roles and fields
 * are preserved as-is.
 */

export interface TextPart {
	type: "text";
	text: string;
}

export interface ThinkingPart {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}

export interface ImagePart {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ToolCallPart {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	/** Raw JSON streamed so far (client-side only, while the call is being generated). */
	partialJson?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost?: { total: number };
}

export interface UserMessage {
	role: "user";
	content: string | Array<TextPart | ImagePart>;
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: Array<TextPart | ThinkingPart | ToolCallPart>;
	provider?: string;
	model?: string;
	usage?: Usage;
	stopReason?: string;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: Array<TextPart | ImagePart>;
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	timestamp: number;
}

export interface CustomMessage {
	role: "custom";
	customType: string;
	content: string | Array<TextPart | ImagePart>;
	display: boolean;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	timestamp: number;
}

export interface UnknownMessage {
	role: string;
	timestamp?: number;
	[key: string]: unknown;
}

export type ChatMessage =
	| UserMessage
	| AssistantMessage
	| ToolResultMessage
	| BashExecutionMessage
	| CustomMessage
	| CompactionSummaryMessage
	| BranchSummaryMessage;

export type AnyMessage = ChatMessage | UnknownMessage;

/** Plain text of a message content value (string or content parts). */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
}

/**
 * One of the notes pi appends to a user prompt after normalizing its attached images
 * (`[Image: original WxH, displayed at WxH. ...]`, `[Image omitted: ...]`,
 * `[Image converted from A to B.]`). They are meant for the model, not the user.
 */
const IMAGE_HINT_LINE =
	/^\[Image(?:: original \d+[x×]\d+, displayed at \d+[x×]\d+\. Multiply coordinates by [\d.]+ to map to original image\.| omitted: .+| converted from \S+ to \S+\.)\]$/;

/**
 * Remove the image-normalization notes pi appends as `${text}\n\n${hints}` to user prompts
 * that carry images. Text without that exact trailing block is returned unchanged.
 */
export function stripImageHints(text: string): string {
	const lines = text.split("\n");
	let end = lines.length;
	while (end > 0 && IMAGE_HINT_LINE.test(lines[end - 1] ?? "")) end--;
	if (end === lines.length || end === 0 || lines[end - 1] !== "") return text;
	return lines.slice(0, end - 1).join("\n");
}

/** An image note at the end of a one-line summary, where pi joined the text parts with spaces. */
const TRAILING_IMAGE_HINT =
	/\s*\[Image(?:: original \d+[x×]\d+, displayed at \d+[x×]\d+\. Multiply coordinates by [\d.]+ to map to original image\.| omitted: [^\]\n]+| converted from \S+ to \S+\.)\]\s*$/;
/** The start of an image note cut off by a length limit. */
const CUT_IMAGE_HINT = /\s*\[Image(?:: original \d|: original$| omitted:| converted from )[^\]]*$/;

/**
 * Remove pi's image notes from the end of a session summary such as `firstMessage`, which pi
 * builds by joining text parts with spaces and which may be cut off in the middle of a note.
 */
export function stripTrailingImageHints(text: string): string {
	let out = stripImageHints(text).replace(CUT_IMAGE_HINT, "");
	for (let next = out.replace(TRAILING_IMAGE_HINT, ""); next !== out; next = out.replace(TRAILING_IMAGE_HINT, "")) {
		out = next;
	}
	return out;
}

/** Display text of a user message: its text parts without pi's image notes. */
export function userText(content: unknown): string {
	return stripImageHints(contentText(content));
}

/** Image parts of a message content value. */
export function contentImages(content: unknown): ImagePart[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(part): part is ImagePart => !!part && typeof part === "object" && (part as { type?: unknown }).type === "image",
	);
}

export function isRole<R extends ChatMessage["role"]>(
	message: AnyMessage,
	role: R,
): message is Extract<ChatMessage, { role: R }> {
	return message.role === role;
}
