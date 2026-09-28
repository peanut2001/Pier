import type {
	ModelInfo,
	SessionRunState,
	SessionSnapshot,
	SessionSummary,
	UiRequest,
	UiResolution,
	UiResponse,
} from "./domain.ts";

/**
 * Pi session events forwarded verbatim (after pi's JSON wire transformation, which
 * strips cumulative `partial` snapshots from `message_update`).
 *
 * The protocol package intentionally does not depend on the pi SDK so it can be used
 * by the React Native client; these types document the fields clients rely on.
 */
export const PI_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"session_info_changed",
	"thinking_level_changed",
	"entry_appended",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
] as const;

export type PiEventType = (typeof PI_EVENT_TYPES)[number];

export interface PiEvent {
	type: PiEventType;
	[key: string]: unknown;
}

/** Pier-specific session events. All of these carry a `seq` except `session.snapshot`. */
export type PierSessionEvent =
	| { type: "session.snapshot"; snapshot: SessionSnapshot }
	| { type: "session.status"; state: SessionRunState }
	| { type: "session.replaced"; previousSessionId: string; session: SessionSummary }
	| { type: "session.closed"; reason: "idle" | "closed" | "host_shutdown" }
	| { type: "session.model"; model?: ModelInfo; thinkingLevel: string }
	| { type: "ui.request"; request: UiRequest }
	| {
			type: "ui.resolved";
			requestId: string;
			resolution: UiResolution;
			response?: UiResponse;
			/** Connection id of the client that answered, when answered. */
			by?: string;
	  }
	| { type: "ui.notify"; message: string; level: "info" | "warning" | "error" }
	| { type: "ui.status"; key: string; text?: string }
	| { type: "ui.widget"; key: string; lines?: string[]; placement?: string }
	| { type: "ui.title"; title: string }
	| { type: "ui.editorText"; text: string }
	| { type: "extension.error"; extensionPath: string; event: string; error: string };

/** Host-scoped events (no `sessionId`, no `seq`). */
export type PierHostEvent =
	| { type: "host.notice"; level: "info" | "warning" | "error"; message: string; sessionId?: string }
	| { type: "workspace.changed" }
	| { type: "session.listChanged"; workspaceId: string };

export type PierEvent = PierSessionEvent | PierHostEvent;
export type PierEventType = PierEvent["type"];
