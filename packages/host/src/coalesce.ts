import type { EventFrame } from "@pier/protocol";

const MERGEABLE_DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);

interface DeltaInfo {
	kind: string;
	contentIndex: number;
	delta: string;
}

function deltaInfo(frame: EventFrame): DeltaInfo | undefined {
	if (frame.event.type !== "message_update") return undefined;
	const inner = frame.event.assistantMessageEvent as Record<string, unknown> | undefined;
	if (!inner || typeof inner.type !== "string" || !MERGEABLE_DELTAS.has(inner.type)) return undefined;
	if (typeof inner.delta !== "string" || typeof inner.contentIndex !== "number") return undefined;
	return { kind: inner.type, contentIndex: inner.contentIndex, delta: inner.delta };
}

/**
 * Merges consecutive streaming deltas (same session, same content block) that arrive
 * within `windowMs` into one frame. The merged frame carries the seq of the last
 * merged event, so a client that resumes from it never re-applies a merged delta.
 * Any other frame flushes the pending merge first, so ordering is preserved.
 */
export class DeltaCoalescer {
	private pending: { frame: EventFrame; info: DeltaInfo } | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly windowMs: number,
		private readonly emit: (frame: EventFrame) => void,
	) {}

	push(frame: EventFrame): void {
		const info = this.windowMs > 0 ? deltaInfo(frame) : undefined;
		if (!info) {
			this.flush();
			this.emit(frame);
			return;
		}
		const pending = this.pending;
		if (
			pending &&
			pending.frame.sessionId === frame.sessionId &&
			pending.info.kind === info.kind &&
			pending.info.contentIndex === info.contentIndex
		) {
			pending.info.delta += info.delta;
			const inner = pending.frame.event.assistantMessageEvent as Record<string, unknown>;
			pending.frame = {
				...frame,
				event: {
					...frame.event,
					assistantMessageEvent: { ...inner, delta: pending.info.delta },
				},
			};
			return;
		}
		this.flush();
		this.pending = { frame, info: { ...info } };
		this.timer = setTimeout(() => this.flush(), this.windowMs);
	}

	flush(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const pending = this.pending;
		this.pending = undefined;
		if (pending) this.emit(pending.frame);
	}

	/** Drop any pending frame without emitting it. */
	dispose(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
	}
}
