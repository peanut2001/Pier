import { randomUUID } from "node:crypto";
import {
	type ClientInfo,
	type EventFrame,
	type HostFrame,
	PierProtocolError,
	type ResponseFrame,
} from "@pier/protocol";
import { DeltaCoalescer } from "./coalesce.ts";
import type { ManagedSession, SessionSubscriber } from "./managed-session.ts";

/** Minimal message transport (a WebSocket, or an in-memory pipe in tests). */
export interface Transport {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	/** Bytes queued but not yet flushed, when the transport can report it. */
	readonly bufferedAmount?: number;
}

export type ConnectionKind = "local" | "remote";

/** The paired device behind a remote connection (authenticated by the secure channel). */
export interface RemoteDevice {
	id: string;
	name: string;
	/** Network address the device connected from. */
	address?: string;
}

export interface RequestHandler {
	handle(connection: Connection, raw: string): Promise<{ response: ResponseFrame; after: Array<() => void> }>;
	disconnected(connection: Connection): void;
}

/** Close the connection when this many bytes are queued; the client resumes with `sinceSeq`. */
export const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

export class Connection implements SessionSubscriber {
	readonly connectionId = randomUUID();
	authenticated = false;
	client: ClientInfo | undefined;
	readonly subscriptions = new Set<ManagedSession>();
	private coalescer: DeltaCoalescer | undefined;
	private closed = false;
	/** Frames are handled one at a time until `host.hello` succeeds, so clients may pipeline after hello. */
	private preAuthChain: Promise<void> = Promise.resolve();

	constructor(
		readonly kind: ConnectionKind,
		private readonly transport: Transport,
		private readonly handler: RequestHandler,
		/** Set for remote connections. */
		readonly device?: RemoteDevice,
	) {}

	get isClosed(): boolean {
		return this.closed;
	}

	setCoalesceWindow(ms: number): void {
		this.coalescer?.flush();
		this.coalescer = ms > 0 ? new DeltaCoalescer(ms, (frame) => this.write(frame)) : undefined;
	}

	/** Deliver an event frame (session subscriptions and host broadcasts). */
	send(frame: EventFrame): void {
		if (this.closed) return;
		if (this.coalescer) this.coalescer.push(frame);
		else this.write(frame);
	}

	private write(frame: HostFrame): void {
		if (this.closed) return;
		if ((this.transport.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) {
			this.close(1013, "Client is not keeping up; reconnect and resume");
			return;
		}
		try {
			this.transport.send(JSON.stringify(frame));
		} catch {
			this.close(1011, "Send failed");
		}
	}

	async receive(raw: string): Promise<void> {
		if (this.closed) return;
		if (!this.authenticated) {
			const run = this.preAuthChain.then(() => this.process(raw));
			this.preAuthChain = run.catch(() => undefined);
			return run;
		}
		return this.process(raw);
	}

	private async process(raw: string): Promise<void> {
		if (this.closed) return;
		const { response, after } = await this.handler.handle(this, raw);
		// Responses must not overtake nor be overtaken by pending merged deltas.
		this.coalescer?.flush();
		this.write(response);
		for (const fn of after) fn();
	}

	close(code = 1000, reason = ""): void {
		if (this.closed) return;
		this.closed = true;
		this.coalescer?.dispose();
		try {
			this.transport.close(code, reason);
		} catch {
			// Already closed.
		}
		this.handler.disconnected(this);
	}

	/** The transport closed from the remote side. */
	onTransportClosed(): void {
		if (this.closed) return;
		this.closed = true;
		this.coalescer?.dispose();
		this.handler.disconnected(this);
	}
}

export function badFrameResponse(raw: string): ResponseFrame {
	let id = "";
	try {
		const value = JSON.parse(raw) as { id?: unknown };
		if (typeof value.id === "string") id = value.id;
	} catch {
		// Not JSON.
	}
	return {
		type: "res",
		id,
		ok: false,
		error: new PierProtocolError("BAD_REQUEST", "Invalid request frame").toJSON(),
	};
}
