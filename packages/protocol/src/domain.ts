import { z } from "zod";

/** Workspace approval policy for the built-in `pier-approval` extension. */
export const ApprovalPolicySchema = z.enum(["ask", "smart", "auto"]);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const ThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = z.infer<typeof ThinkingLevelSchema>;

export const StreamingBehaviorSchema = z.enum(["steer", "followUp"]);
export type StreamingBehavior = z.infer<typeof StreamingBehaviorSchema>;

export const ImageInputSchema = z.object({
	type: z.literal("image"),
	/** Base64 data without the `data:` prefix. */
	data: z.string().min(1),
	mimeType: z.string().regex(/^image\/[\w.+-]+$/),
});
export type ImageInput = z.infer<typeof ImageInputSchema>;

export interface WorkspaceInfo {
	id: string;
	name: string;
	/** Absolute directory used as the pi `cwd`. */
	path: string;
	policy: ApprovalPolicy;
	addedAt: string;
}

/** Runtime state of a session as seen by clients. */
export type SessionRunState = "inactive" | "idle" | "streaming" | "compacting" | "retrying";

export interface SessionSummary {
	id: string;
	workspaceId: string;
	/** Session JSONL path. Undefined for sessions that have not been persisted. */
	path?: string;
	name?: string;
	cwd: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	parentSessionPath?: string;
	/** Whether the host currently holds this session in its active pool. */
	active: boolean;
	state: SessionRunState;
	/** Dialogs / approvals waiting for an answer (active sessions only). Added in 1.1. */
	pendingUi?: number;
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow?: number;
}

export interface QueueState {
	steering: string[];
	followUp: string[];
}

export type UiRequestKind = "select" | "confirm" | "input" | "editor" | "approval";

export type ApprovalSeverity = "normal" | "high";

export interface ApprovalDetails {
	toolName: string;
	toolCallId: string;
	/** One-line human readable description, e.g. the bash command or file path. */
	summary: string;
	/** Tool input, with long string fields truncated. */
	input: Record<string, unknown>;
	/** Why the policy asked for approval. */
	reason: string;
	severity: ApprovalSeverity;
	/** Whether "allow for this session" is offered for this call. */
	sessionAllowable: boolean;
	/** Human readable scope of an "allow for this session" answer. */
	sessionScope?: string;
}

export interface UiRequest {
	id: string;
	sessionId: string;
	kind: UiRequestKind;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	approval?: ApprovalDetails;
	createdAt: string;
	/** ISO timestamp after which the host resolves the request with its default answer. */
	expiresAt?: string;
}

export const ApprovalDecisionSchema = z.enum(["allow_once", "allow_session", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * Answer to a {@link UiRequest}. Which fields are meaningful depends on the request kind:
 * - `select`, `input`, `editor`: `value` or `cancelled`
 * - `confirm`: `confirmed`
 * - `approval`: `decision` and an optional `reason` shown to the model on deny
 */
export const UiResponseSchema = z.object({
	cancelled: z.boolean().optional(),
	value: z.string().optional(),
	confirmed: z.boolean().optional(),
	decision: ApprovalDecisionSchema.optional(),
	reason: z.string().max(2000).optional(),
});
export type UiResponse = z.infer<typeof UiResponseSchema>;

export type UiResolution = "answered" | "timeout" | "cancelled";

export interface HostInfo {
	hostId: string;
	hostName: string;
	version: string;
	protocolVersion: string;
	platform: string;
	piVersion: string;
	agentDir: string;
}

export interface ClientInfo {
	name: string;
	version: string;
	platform?: string;
}

/**
 * Everything a client needs to render a session from scratch.
 * Events with `seq > snapshot.seq` apply on top of it.
 */
export interface SessionSnapshot {
	session: SessionSummary;
	seq: number;
	epoch: string;
	/** Finalized transcript messages (pi `AgentMessage` values). */
	messages: unknown[];
	/** Partial assistant message currently being streamed, if any. */
	streamingMessage?: unknown;
	pendingToolCalls: string[];
	pendingUi: UiRequest[];
	queue: QueueState;
	model?: ModelInfo;
	thinkingLevel: ThinkingLevel;
	statuses: Record<string, string>;
	widgets: Record<string, { lines: string[]; placement?: string }>;
	title?: string;
	errorMessage?: string;
}

/** A remote device paired with this host (see `docs/security.md`). */
export interface DeviceInfo {
	id: string;
	name: string;
	platform?: string;
	model?: string;
	appVersion?: string;
	/** Fingerprint of the device's static key, e.g. `K7QF-2M4A-XJ3D-9PLR`. */
	fingerprint: string;
	pairedAt: string;
	lastSeenAt?: string;
	/** Whether the device currently has an open connection. */
	connected: boolean;
}

/** Remote access (LAN / Tailscale) listener state. */
export interface RemoteAccessStatus {
	enabled: boolean;
	/** Configured port (the actual port while running). */
	port: number;
	running: boolean;
	/** `host:port` candidates put into pairing codes. */
	addresses: string[];
	/** Fingerprint of the host's static key, shown to compare with the phone. */
	hostFingerprint: string;
	/** Whether the host is advertised over mDNS (`_pier._tcp`). */
	mdns: boolean;
	/** Why the listener is not running although enabled (e.g. port in use). */
	error?: string;
	/** Whether a pairing code is currently valid. */
	pairingActive: boolean;
}

/** A device that presented a valid pairing code and waits for the desktop user's decision. */
export interface PairingRequest {
	id: string;
	device: { name: string; platform?: string; model?: string; appVersion?: string };
	fingerprint: string;
	/** Remote network address of the device, for display. */
	address?: string;
	createdAt: string;
	expiresAt: string;
}

export type PairingResolution = "accepted" | "rejected" | "expired" | "cancelled";
