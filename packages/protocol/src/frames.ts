import { z } from "zod";
import { ERROR_CODES, type ProtocolErrorShape } from "./errors.ts";

export const RequestFrameSchema = z.object({
	type: z.literal("req"),
	id: z.string().min(1).max(128),
	method: z.string().min(1).max(128),
	params: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof RequestFrameSchema>;

export const ErrorShapeSchema = z.object({
	code: z.enum(ERROR_CODES),
	message: z.string(),
	data: z.unknown().optional(),
});

export const ResponseFrameSchema = z.discriminatedUnion("ok", [
	z.object({ type: z.literal("res"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
	z.object({ type: z.literal("res"), id: z.string(), ok: z.literal(false), error: ErrorShapeSchema }),
]);
export type ResponseFrame =
	| { type: "res"; id: string; ok: true; result: unknown }
	| { type: "res"; id: string; ok: false; error: ProtocolErrorShape };

/** A protocol event. `type` is either a pi session event type or a Pier event type. */
export interface WireEvent {
	type: string;
	[key: string]: unknown;
}

export const EventFrameSchema = z.object({
	type: z.literal("evt"),
	/** Present for session-scoped events. */
	sessionId: z.string().optional(),
	/** Per-session monotonically increasing sequence number. Absent for events that are not logged. */
	seq: z.number().int().nonnegative().optional(),
	event: z.looseObject({ type: z.string() }),
});
export interface EventFrame {
	type: "evt";
	sessionId?: string;
	seq?: number;
	event: WireEvent;
}

export type ClientFrame = RequestFrame;
export type HostFrame = ResponseFrame | EventFrame;

export const HostFrameSchema = z.union([ResponseFrameSchema, EventFrameSchema]);

/** Parse a raw text frame sent by a client. Returns undefined when it is not a valid request frame. */
export function parseClientFrame(raw: string): RequestFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const parsed = RequestFrameSchema.safeParse(value);
	return parsed.success ? parsed.data : undefined;
}

/** Parse a raw text frame sent by a host. Returns undefined when it is not a valid host frame. */
export function parseHostFrame(raw: string): HostFrame | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const parsed = HostFrameSchema.safeParse(value);
	return parsed.success ? (parsed.data as HostFrame) : undefined;
}
