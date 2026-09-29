import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { platform } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import {
	type EventFrame,
	type HostInfo,
	isMethodName,
	isProtocolCompatible,
	LOCAL_ONLY_EVENTS,
	LOCAL_ONLY_METHODS,
	type MethodName,
	MethodParamsSchemas,
	type MethodResult,
	type ParsedMethodParams,
	type PierHostEvent,
	PierProtocolError,
	PROTOCOL_VERSION,
	parseClientFrame,
	type ResponseFrame,
	type WorkspaceInfo,
} from "@pier/protocol";
import { ConfigStore } from "./config.ts";
import {
	badFrameResponse,
	Connection,
	type ConnectionKind,
	type RemoteDevice,
	type RequestHandler,
	type Transport,
} from "./connection.ts";
import type { ManagedSession } from "./managed-session.ts";
import { configPath, defaultPierDir, locksDir } from "./paths.ts";
import { PI_VERSION, PiEnvironment, type PiEnvironmentOptions, toModelInfo } from "./pi/environment.ts";
import { NewApiManager } from "./pi/newapi.ts";
import { ProviderManager } from "./pi/providers.ts";
import { RemoteAccess, type RemoteAccessOptions } from "./remote/remote-access.ts";
import { SessionPool } from "./session-pool.ts";

export const PIER_HOST_VERSION = "0.2.1";

/** Unauthenticated connections are closed after this long without a successful `host.hello`. */
export const HELLO_TIMEOUT_MS = 10_000;

export interface PierHostOptions {
	pierDir?: string;
	/** A ready environment, or options to create one. */
	env?: PiEnvironment | PiEnvironmentOptions;
	/** Token local clients must present in `host.hello`. Required for local connections. */
	localToken: string;
	uiTimeoutMs?: number;
	idleTimeoutMs?: number;
	eventLogCapacity?: number;
	sweepIntervalMs?: number;
	/** Remote access overrides (tests, CLI flags). Saved settings live in config.json. */
	remote?: RemoteAccessOptions;
	/** Diagnostic log sink (stderr in the sidecar). */
	log?: (message: string) => void;
}

/** Remote methods recorded in the audit log. */
const AUDITED_METHODS = new Set<MethodName>([
	"session.create",
	"session.open",
	"session.close",
	"session.fork",
	"session.rename",
	"session.prompt",
	"session.steer",
	"session.followUp",
	"session.abort",
	"session.compact",
	"model.set",
	"thinking.set",
	"ui.respond",
]);

function auditDetail(method: MethodName, params: Record<string, unknown>): Record<string, unknown> | undefined {
	switch (method) {
		case "session.prompt":
		case "session.steer":
		case "session.followUp":
			return {
				textLength: typeof params.text === "string" ? params.text.length : 0,
				images: Array.isArray(params.images) ? params.images.length : 0,
			};
		case "ui.respond": {
			const response = (params.response ?? {}) as Record<string, unknown>;
			return {
				requestId: params.requestId,
				...(response.decision ? { decision: response.decision } : {}),
				...(response.confirmed !== undefined ? { confirmed: response.confirmed } : {}),
				...(response.cancelled ? { cancelled: true } : {}),
			};
		}
		case "model.set":
			return { provider: params.provider, modelId: params.modelId };
		case "thinking.set":
			return { level: params.level };
		default:
			return undefined;
	}
}

interface HandlerContext {
	connection: Connection;
	after(fn: () => void): void;
}

type Handlers = {
	[M in MethodName]: (ctx: HandlerContext, params: ParsedMethodParams<M>) => Promise<MethodResult<M>> | MethodResult<M>;
};

function tokensEqual(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function toProtocolError(error: unknown): PierProtocolError {
	if (error instanceof PierProtocolError) return error;
	return new PierProtocolError("INTERNAL", error instanceof Error ? error.message : String(error));
}

/**
 * Pier Host: owns workspaces and the session pool and serves the Pier protocol
 * to any number of connections, independent of the transport.
 */
export class PierHost implements RequestHandler {
	readonly pierDir: string;
	readonly config: ConfigStore;
	readonly env: PiEnvironment;
	readonly pool: SessionPool;
	readonly remote: RemoteAccess;
	readonly providers: ProviderManager;
	readonly newapi: NewApiManager;
	private readonly connections = new Set<Connection>();
	private readonly localToken: string;
	private readonly handlers: Handlers;
	private shuttingDown = false;

	private constructor(options: PierHostOptions, env: PiEnvironment) {
		if (!options.localToken || options.localToken.length < 16) {
			throw new Error("PierHost requires a local token of at least 16 characters");
		}
		this.pierDir = options.pierDir ?? defaultPierDir();
		mkdirSync(this.pierDir, { recursive: true, mode: 0o700 });
		this.config = new ConfigStore(configPath(this.pierDir));
		this.env = env;
		this.localToken = options.localToken;
		this.pool = new SessionPool({
			env,
			config: this.config,
			locksDir: locksDir(this.pierDir),
			...(options.uiTimeoutMs === undefined ? {} : { uiTimeoutMs: options.uiTimeoutMs }),
			...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
			...(options.eventLogCapacity === undefined ? {} : { eventLogCapacity: options.eventLogCapacity }),
			...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
			onSessionReplaced: (session) => this.broadcast({ type: "session.listChanged", workspaceId: session.workspaceId }),
			onSessionActivity: (session) => {
				const summary = session.summary();
				this.broadcast({
					type: "session.activity",
					workspaceId: summary.workspaceId,
					sessionId: summary.id,
					state: summary.state,
					pendingUi: summary.pendingUi ?? 0,
				});
			},
			onSessionClosed: (session) => {
				for (const connection of this.connections) connection.subscriptions.delete(session);
				this.broadcast({ type: "session.listChanged", workspaceId: session.workspaceId });
			},
		});
		const log = options.log ?? (() => {});
		this.providers = new ProviderManager(env, {
			onChanged: () => this.broadcast({ type: "provider.changed" }),
			log,
		});
		this.newapi = new NewApiManager({ log });
		this.remote = new RemoteAccess(
			this.pierDir,
			this.config,
			{
				hostId: () => this.config.hostId,
				hostName: () => this.config.hostName,
				connect: (transport, device) => this.connect(transport, "remote", device),
				broadcastLocal: (event) => this.broadcast(event),
				remoteConnections: () => [...this.connections].filter((c) => c.kind === "remote"),
				log,
			},
			options.remote,
		);
		this.handlers = this.createHandlers();
	}

	static async create(options: PierHostOptions): Promise<PierHost> {
		const env = options.env instanceof PiEnvironment ? options.env : await PiEnvironment.create(options.env ?? {});
		const host = new PierHost(options, env);
		host.pool.startSweeper();
		await host.remote.apply();
		return host;
	}

	info(): HostInfo {
		return {
			hostId: this.config.hostId,
			hostName: this.config.hostName,
			version: PIER_HOST_VERSION,
			protocolVersion: PROTOCOL_VERSION,
			platform: platform(),
			piVersion: PI_VERSION,
			agentDir: this.env.agentDir,
		};
	}

	get connectionCount(): number {
		return this.connections.size;
	}

	/** Attach a new transport. Feed incoming text frames to `connection.receive()`. */
	connect(transport: Transport, kind: ConnectionKind, device?: RemoteDevice): Connection {
		const connection = new Connection(kind, transport, this, device);
		this.connections.add(connection);
		const timer = setTimeout(() => {
			if (!connection.authenticated) connection.close(4401, "host.hello timeout");
		}, HELLO_TIMEOUT_MS);
		timer.unref?.();
		return connection;
	}

	disconnected(connection: Connection): void {
		this.connections.delete(connection);
		this.providers.connectionClosed(connection.connectionId);
		this.newapi.connectionClosed(connection.connectionId);
		for (const session of connection.subscriptions) session.unsubscribe(connection.connectionId);
		connection.subscriptions.clear();
	}

	/** Send a host-scoped event to every authenticated connection (local-only events only to local ones). */
	broadcast(event: PierHostEvent): void {
		const frame: EventFrame = { type: "evt", event };
		const localOnly = LOCAL_ONLY_EVENTS.has(event.type);
		for (const connection of this.connections) {
			if (!connection.authenticated) continue;
			if (localOnly && connection.kind !== "local") continue;
			connection.send(frame);
		}
	}

	async handle(connection: Connection, raw: string): Promise<{ response: ResponseFrame; after: Array<() => void> }> {
		const after: Array<() => void> = [];
		const frame = parseClientFrame(raw);
		if (!frame) return { response: badFrameResponse(raw), after };
		const fail = (error: unknown): { response: ResponseFrame; after: Array<() => void> } => ({
			response: { type: "res", id: frame.id, ok: false, error: toProtocolError(error).toJSON() },
			after: [],
		});

		try {
			if (!isMethodName(frame.method)) {
				throw new PierProtocolError("BAD_REQUEST", `Unknown method ${frame.method}`);
			}
			const method = frame.method;
			if (!connection.authenticated && method !== "host.hello") {
				throw new PierProtocolError("UNAUTHENTICATED", "Call host.hello first");
			}
			if (connection.kind !== "local" && LOCAL_ONLY_METHODS.has(method)) {
				throw new PierProtocolError("FORBIDDEN", `${method} is only available to the desktop app`);
			}
			if (this.shuttingDown) throw new PierProtocolError("CONFLICT", "Host is shutting down");
			const schema = MethodParamsSchemas[method];
			const parsed = schema.safeParse(frame.params);
			if (!parsed.success) {
				throw new PierProtocolError("BAD_REQUEST", `Invalid params for ${method}`, parsed.error.issues);
			}
			if (connection.device && AUDITED_METHODS.has(method)) {
				const params = (parsed.data ?? {}) as Record<string, unknown>;
				const detail = auditDetail(method, params);
				this.remote.record({
					event: method,
					deviceId: connection.device.id,
					deviceName: connection.device.name,
					...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
					...(detail ? { detail } : {}),
				});
			}
			const handler = this.handlers[method] as (ctx: HandlerContext, params: unknown) => unknown;
			const result = await handler({ connection, after: (fn) => after.push(fn) }, parsed.data);
			return { response: { type: "res", id: frame.id, ok: true, result: result ?? {} }, after };
		} catch (error) {
			const response = fail(error);
			if (frame.method === "host.hello" && !connection.authenticated) {
				response.after.push(() => connection.close(4401, "Authentication failed"));
			}
			return response;
		}
	}

	private requireWorkspace(workspaceId: string): WorkspaceInfo {
		const workspace = this.config.getWorkspace(workspaceId);
		if (!workspace) throw new PierProtocolError("NOT_FOUND", `Workspace ${workspaceId} not found`);
		return workspace;
	}

	private subscribeConnection(ctx: HandlerContext, session: ManagedSession, sinceSeq?: number, epoch?: string) {
		const pending = session.subscribe(ctx.connection, sinceSeq, epoch);
		ctx.connection.subscriptions.add(session);
		ctx.after(pending.start);
		return pending.result;
	}

	private createHandlers(): Handlers {
		return {
			"host.hello": (ctx, params) => {
				if (!isProtocolCompatible(params.protocolVersion)) {
					throw new PierProtocolError(
						"PROTOCOL_MISMATCH",
						`Host speaks protocol ${PROTOCOL_VERSION}; client speaks ${params.protocolVersion}. Please upgrade.`,
						{ hostVersion: PROTOCOL_VERSION },
					);
				}
				const device = ctx.connection.device;
				if (ctx.connection.kind === "local") {
					if (!params.token || !tokensEqual(params.token, this.localToken)) {
						throw new PierProtocolError("UNAUTHENTICATED", "Invalid local token");
					}
				} else if (!device || !this.remote.isRegistered(device.id)) {
					// The secure channel authenticated the device; it may have been revoked since.
					throw new PierProtocolError("UNAUTHENTICATED", "This device is no longer paired");
				}
				ctx.connection.authenticated = true;
				ctx.connection.client = params.client;
				ctx.connection.setCoalesceWindow(params.coalesceMs ?? 0);
				return {
					protocolVersion: PROTOCOL_VERSION,
					host: this.info(),
					connectionId: ctx.connection.connectionId,
					...(device ? { device: { id: device.id, name: device.name } } : {}),
				};
			},
			"host.info": () => this.info(),

			"workspace.list": () => ({ workspaces: this.config.listWorkspaces() }),
			"workspace.add": (_ctx, params) => {
				if (!isAbsolute(params.path)) throw new PierProtocolError("BAD_REQUEST", "Workspace path must be absolute");
				const path = resolve(params.path);
				if (!existsSync(path) || !statSync(path).isDirectory()) {
					throw new PierProtocolError("BAD_REQUEST", `Not a directory: ${path}`);
				}
				const real = realpathSync(path);
				const workspace = this.config.addWorkspace({
					path: real,
					name: params.name ?? (basename(real) || real),
					...(params.policy ? { policy: params.policy } : {}),
				});
				this.broadcast({ type: "workspace.changed" });
				return { workspace };
			},
			"workspace.remove": async (_ctx, params) => {
				for (const session of this.pool.all()) {
					if (session.workspaceId === params.workspaceId) await this.pool.close(session.id, true);
				}
				const removed = this.config.removeWorkspace(params.workspaceId);
				if (removed) this.broadcast({ type: "workspace.changed" });
				return { removed };
			},
			"workspace.setPolicy": (_ctx, params) => {
				const workspace = this.config.setWorkspacePolicy(params.workspaceId, params.policy);
				if (!workspace) throw new PierProtocolError("NOT_FOUND", `Workspace ${params.workspaceId} not found`);
				this.broadcast({ type: "workspace.changed" });
				return { workspace };
			},

			"session.list": async (_ctx, params) => ({
				sessions: await this.pool.list(this.requireWorkspace(params.workspaceId)),
			}),
			"session.create": async (_ctx, params) => {
				const session = await this.pool.create(this.requireWorkspace(params.workspaceId), params.name);
				this.broadcast({ type: "session.listChanged", workspaceId: params.workspaceId });
				return { session: session.summary() };
			},
			"session.open": async (_ctx, params) => {
				const workspace = this.requireWorkspace(params.workspaceId);
				const target = "sessionId" in params ? { sessionId: params.sessionId } : { path: params.path };
				const session = await this.pool.open(workspace, target);
				return { session: session.summary() };
			},
			"session.close": async (_ctx, params) => ({ closed: await this.pool.close(params.sessionId, params.force) }),
			"session.forkPoints": (_ctx, params) => ({ points: this.pool.require(params.sessionId).forkPoints() }),
			"session.fork": async (_ctx, params) => {
				const source = this.pool.require(params.sessionId);
				const { session, selectedText } = await this.pool.fork(source, params.entryId, params.position ?? "before");
				this.broadcast({ type: "session.listChanged", workspaceId: session.workspaceId });
				return selectedText === undefined
					? { session: session.summary() }
					: { session: session.summary(), selectedText };
			},
			"session.rename": (_ctx, params) => {
				const summary = this.pool.require(params.sessionId).rename(params.name);
				this.broadcast({ type: "session.listChanged", workspaceId: summary.workspaceId });
				return { session: summary };
			},
			"session.subscribe": (ctx, params) =>
				this.subscribeConnection(ctx, this.pool.require(params.sessionId), params.sinceSeq, params.epoch),
			"session.unsubscribe": (ctx, params) => {
				const session = this.pool.get(params.sessionId);
				if (!session) return { unsubscribed: false };
				ctx.connection.subscriptions.delete(session);
				return { unsubscribed: session.unsubscribe(ctx.connection.connectionId) };
			},
			"session.snapshot": (_ctx, params) => this.pool.require(params.sessionId).snapshot(),

			"session.prompt": async (_ctx, params) => {
				await this.pool.require(params.sessionId).prompt(params.text, params.images, params.streamingBehavior);
				return { accepted: true as const };
			},
			"session.steer": async (_ctx, params) => ({
				queue: await this.pool.require(params.sessionId).steer(params.text, params.images),
			}),
			"session.followUp": async (_ctx, params) => ({
				queue: await this.pool.require(params.sessionId).followUp(params.text, params.images),
			}),
			"session.abort": async (_ctx, params) => {
				await this.pool.require(params.sessionId).abort();
				return { aborted: true as const };
			},
			"session.compact": (_ctx, params) => this.pool.require(params.sessionId).compact(params.instructions),

			"model.list": async (_ctx, params) => {
				const models = await this.env.listModels();
				const session = params?.sessionId ? this.pool.require(params.sessionId) : undefined;
				const current = session?.session.model;
				return current ? { models, current: toModelInfo(current) } : { models };
			},
			"model.set": async (_ctx, params) => ({
				model: await this.pool
					.require(params.sessionId)
					.setModel(params.provider, params.modelId, params.persist ?? false),
			}),
			"thinking.set": (_ctx, params) => ({
				level: this.pool.require(params.sessionId).setThinking(params.level, params.persist ?? false),
			}),
			"model.setDefault": async (_ctx, params) => ({
				defaultModel: await this.providers.setDefault(params.provider, params.modelId),
			}),

			"provider.list": () => this.providers.list(),
			"provider.login": (ctx, params) => {
				const { flowId, start } = this.providers.login(ctx.connection, params.providerId, params.method);
				ctx.after(start);
				return { flowId };
			},
			"provider.loginRespond": (ctx, params) => ({
				accepted: this.providers.respond(
					ctx.connection.connectionId,
					params.flowId,
					params.promptId,
					params.value,
					params.cancelled,
				),
			}),
			"provider.loginCancel": (ctx, params) => ({
				cancelled: this.providers.cancel(ctx.connection.connectionId, params.flowId),
			}),
			"provider.logout": async (_ctx, params) => ({ removed: await this.providers.logout(params.providerId) }),
			"provider.saveCustom": (ctx, params) =>
				this.providers.saveCustom(
					params.provider,
					params.apiKeyRef ? this.newapi.resolveKey(ctx.connection.connectionId, params.apiKeyRef) : params.apiKey,
					params.create ?? false,
				),
			"provider.removeCustom": async (_ctx, params) => ({
				removed: await this.providers.removeCustom(params.providerId),
			}),
			"provider.probeModels": async (ctx, { apiKeyRef, ...params }) => ({
				models: await this.providers.probeModels(
					apiKeyRef ? { ...params, apiKey: this.newapi.resolveKey(ctx.connection.connectionId, apiKeyRef) } : params,
				),
			}),

			"newapi.login": (ctx, params) => this.newapi.login(ctx.connection.connectionId, params),
			"newapi.verify": (ctx, params) => this.newapi.verify(ctx.connection.connectionId, params.sessionId, params.code),
			"newapi.createToken": (ctx, params) =>
				this.newapi.createToken(ctx.connection.connectionId, params.sessionId, params.name, params.group),
			"newapi.useToken": (ctx, params) =>
				this.newapi.useToken(ctx.connection.connectionId, params.sessionId, params.tokenId),
			"newapi.close": async (ctx, params) => ({
				closed: await this.newapi.close(ctx.connection.connectionId, params.sessionId),
			}),

			"ui.respond": (ctx, params) => ({
				accepted: this.pool
					.require(params.sessionId)
					.respondUi(params.requestId, params.response, ctx.connection.connectionId),
			}),

			"device.list": () => ({ devices: this.remote.listDevices() }),
			"device.revoke": (_ctx, params) => ({ revoked: this.remote.revoke(params.deviceId) }),
			"device.rename": (_ctx, params) => ({ device: this.remote.rename(params.deviceId, params.name) }),
			"pairing.start": () => this.remote.startPairing(),
			"pairing.cancel": () => ({ cancelled: this.remote.cancelPairing() }),
			"pairing.respond": (_ctx, params) => ({ accepted: this.remote.respondPairing(params.requestId, params.accept) }),

			"remote.status": () => this.remote.status(),
			"remote.configure": (_ctx, params) => this.remote.configure(params),
		};
	}

	async shutdown(): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.broadcast({ type: "host.notice", level: "warning", message: "Pier host is shutting down" });
		this.providers.shutdown();
		this.newapi.shutdown();
		await this.remote.shutdown();
		await this.pool.disposeAll();
		for (const connection of [...this.connections]) connection.close(1001, "Host shutting down");
	}
}
