import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WireEvent } from "@pier/protocol";

/**
 * Convert a pi session event to its wire form.
 *
 * Mirrors pi's JSON/RPC mode: `message_update` drops the cumulative `partial` message
 * (clients rebuild it from `message_start` + deltas, and `message_end` is authoritative).
 * `entry_appended` is reduced to entry metadata because message entries repeat the
 * `message_end` payload.
 */
export function toWireEvent(event: AgentSessionEvent): WireEvent | undefined {
	if (event.type === "message_update") {
		const message = event.message as { role?: string; usage?: unknown };
		if (message.role !== "assistant") return undefined;
		const inner = event.assistantMessageEvent as unknown as Record<string, unknown>;
		const { partial, ...delta } = inner;
		if (inner.type === "toolcall_start") {
			const content = (partial as { content?: Array<Record<string, unknown>> } | undefined)?.content;
			const toolCall = content?.[inner.contentIndex as number];
			if (toolCall?.type === "toolCall") {
				delta.id = toolCall.id;
				delta.toolName = toolCall.name;
			}
		}
		return { type: "message_update", usage: message.usage, assistantMessageEvent: delta };
	}
	if (event.type === "entry_appended") {
		const entry = event.entry as unknown as Record<string, unknown>;
		if (entry.type === "message") {
			const message = entry.message as { role?: string } | undefined;
			return {
				type: "entry_appended",
				entry: {
					type: "message",
					id: entry.id,
					parentId: entry.parentId,
					timestamp: entry.timestamp,
					role: message?.role,
				},
			};
		}
		return { type: "entry_appended", entry };
	}
	return event as unknown as WireEvent;
}
