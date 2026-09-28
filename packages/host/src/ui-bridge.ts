import { randomUUID } from "node:crypto";
import {
	type ApprovalDetails,
	PierProtocolError,
	type PierSessionEvent,
	type UiRequest,
	type UiRequestKind,
	type UiResolution,
	type UiResponse,
} from "@pier/protocol";

export const DEFAULT_UI_TIMEOUT_MS = 30 * 60 * 1000;

export interface UiRequestInput {
	kind: UiRequestKind;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	approval?: ApprovalDetails;
}

export interface UiRequestOptions {
	signal?: AbortSignal;
	/** Overrides the bridge default. 0 disables the timeout. */
	timeoutMs?: number;
}

interface PendingRequest {
	request: UiRequest;
	resolve: (response: UiResponse | undefined) => void;
	timer?: ReturnType<typeof setTimeout>;
	cleanup: () => void;
}

export interface UiBridgeOptions {
	sessionId: () => string;
	emit: (event: PierSessionEvent) => void;
	defaultTimeoutMs?: number;
}

/**
 * Bridges pi's extension UI calls to protocol events.
 *
 * Dialogs become `ui.request` events broadcast to every subscriber. The first valid
 * `ui.respond` wins; everyone then receives `ui.resolved`. Requests stay pending while
 * no client is connected and resolve with their default answer on timeout.
 */
export class UiBridge {
	private readonly pending = new Map<string, PendingRequest>();
	readonly statuses = new Map<string, string>();
	readonly widgets = new Map<string, { lines: string[]; placement?: string }>();
	title: string | undefined;
	private readonly defaultTimeoutMs: number;

	constructor(private readonly options: UiBridgeOptions) {
		this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_UI_TIMEOUT_MS;
	}

	get pendingRequests(): UiRequest[] {
		return [...this.pending.values()].map((p) => p.request);
	}

	getPending(requestId: string): UiRequest | undefined {
		return this.pending.get(requestId)?.request;
	}

	request(input: UiRequestInput, opts: UiRequestOptions = {}): Promise<UiResponse | undefined> {
		if (opts.signal?.aborted) return Promise.resolve(undefined);
		const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
		const now = Date.now();
		const request: UiRequest = {
			id: randomUUID(),
			sessionId: this.options.sessionId(),
			...input,
			createdAt: new Date(now).toISOString(),
			...(timeoutMs > 0 ? { expiresAt: new Date(now + timeoutMs).toISOString() } : {}),
		};
		return new Promise((resolve) => {
			const onAbort = () => this.finish(request.id, "cancelled");
			const entry: PendingRequest = {
				request,
				resolve,
				cleanup: () => {
					if (entry.timer) clearTimeout(entry.timer);
					opts.signal?.removeEventListener("abort", onAbort);
				},
			};
			if (timeoutMs > 0) entry.timer = setTimeout(() => this.finish(request.id, "timeout"), timeoutMs);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(request.id, entry);
			this.options.emit({ type: "ui.request", request });
		});
	}

	/**
	 * Answer a pending request. Returns false when the request is no longer pending
	 * (already answered by another client, timed out, or cancelled).
	 * @throws PierProtocolError when the response does not fit the request kind.
	 */
	respond(requestId: string, response: UiResponse, by?: string): boolean {
		const entry = this.pending.get(requestId);
		if (!entry) return false;
		validateResponse(entry.request, response);
		this.finish(requestId, response.cancelled ? "cancelled" : "answered", response, by);
		return true;
	}

	/** Resolve every pending request with its default answer (host shutdown / session close). */
	cancelAll(): void {
		for (const id of [...this.pending.keys()]) this.finish(id, "cancelled");
	}

	private finish(requestId: string, resolution: UiResolution, response?: UiResponse, by?: string): void {
		const entry = this.pending.get(requestId);
		if (!entry) return;
		this.pending.delete(requestId);
		entry.cleanup();
		this.options.emit({
			type: "ui.resolved",
			requestId,
			resolution,
			...(response ? { response } : {}),
			...(by ? { by } : {}),
		});
		entry.resolve(resolution === "answered" ? response : undefined);
	}

	notify(message: string, level: "info" | "warning" | "error" = "info"): void {
		this.options.emit({ type: "ui.notify", message, level });
	}

	setStatus(key: string, text: string | undefined): void {
		if (text === undefined) this.statuses.delete(key);
		else this.statuses.set(key, text);
		this.options.emit({ type: "ui.status", key, ...(text === undefined ? {} : { text }) });
	}

	setWidget(key: string, lines: string[] | undefined, placement?: string): void {
		if (lines === undefined) this.widgets.delete(key);
		else this.widgets.set(key, placement ? { lines, placement } : { lines });
		this.options.emit({
			type: "ui.widget",
			key,
			...(lines === undefined ? {} : { lines }),
			...(placement ? { placement } : {}),
		});
	}

	setTitle(title: string): void {
		this.title = title;
		this.options.emit({ type: "ui.title", title });
	}

	setEditorText(text: string): void {
		this.options.emit({ type: "ui.editorText", text });
	}
}

function validateResponse(request: UiRequest, response: UiResponse): void {
	if (response.cancelled) return;
	const bad = (message: string): never => {
		throw new PierProtocolError("BAD_REQUEST", message);
	};
	switch (request.kind) {
		case "confirm":
			if (typeof response.confirmed !== "boolean") bad("confirm requests need `confirmed`");
			return;
		case "select":
			if (typeof response.value !== "string") bad("select requests need `value`");
			if (request.options && !request.options.includes(response.value as string)) bad("value is not an option");
			return;
		case "input":
		case "editor":
			if (typeof response.value !== "string") bad(`${request.kind} requests need \`value\``);
			return;
		case "approval":
			if (!response.decision) bad("approval requests need `decision`");
			if (response.decision === "allow_session" && !request.approval?.sessionAllowable) {
				bad("allow_session is not offered for this request");
			}
			return;
	}
}
