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
