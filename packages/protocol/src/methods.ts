import { z } from "zod";
import {
	ApprovalPolicySchema,
	AuthMethodSchema,
	type ClientInfo,
	CustomProviderApiSchema,
	CustomProviderSchema,
	type DefaultModelRef,
	type DeviceInfo,
	type HostInfo,
	ImageInputSchema,
	type ModelInfo,
	type ProviderInfo,
	type ProviderListResult,
	type QueueState,
	type RemoteAccessStatus,
	type SessionSnapshot,
	type SessionSummary,
	StreamingBehaviorSchema,
	ThinkingLevelSchema,
	UiResponseSchema,
	type WorkspaceInfo,
} from "./domain.ts";

const Id = z.string().min(1).max(256);
const SessionRef = { sessionId: Id };
const Text = z.string().max(1_000_000);
const Images = z.array(ImageInputSchema).max(16).optional();

export const ClientInfoSchema = z.object({
	name: z.string().min(1).max(100),
	version: z.string().max(50),
	platform: z.string().max(50).optional(),
}) satisfies z.ZodType<ClientInfo>;

/**
 * Params schema for every method. Methods not listed here are unknown to the protocol.
 */
export const MethodParamsSchemas = {
	"host.hello": z.object({
		protocolVersion: z.string(),
		client: ClientInfoSchema,
		/** Local connection token injected by the desktop shell. */
		token: z.string().max(512).optional(),
		/** Merge streaming text deltas that arrive within this window (ms). 0 disables merging. */
		coalesceMs: z.number().int().min(0).max(1000).optional(),
	}),
	"host.info": z.object({}).optional(),

	"workspace.list": z.object({}).optional(),
	"workspace.add": z.object({
		path: z.string().min(1).max(4096),
		name: z.string().min(1).max(200).optional(),
		policy: ApprovalPolicySchema.optional(),
	}),
	"workspace.remove": z.object({ workspaceId: Id }),
	"workspace.setPolicy": z.object({ workspaceId: Id, policy: ApprovalPolicySchema }),

	"session.list": z.object({ workspaceId: Id }),
	"session.create": z.object({ workspaceId: Id, name: z.string().min(1).max(200).optional() }),
	"session.open": z.union([
		z.object({ workspaceId: Id, sessionId: Id }),
		z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	]),
	"session.close": z.object({ ...SessionRef, force: z.boolean().optional() }),
	"session.forkPoints": z.object(SessionRef),
	"session.fork": z.object({ ...SessionRef, entryId: Id, position: z.enum(["before", "at"]).optional() }),
	"session.rename": z.object({ ...SessionRef, name: z.string().min(1).max(200) }),
	"session.subscribe": z.object({
		...SessionRef,
		/** Last seq the client has applied. Only honored together with a matching `epoch`. */
		sinceSeq: z.number().int().nonnegative().optional(),
		/** Event-log epoch the `sinceSeq` belongs to (from a previous subscribe result or snapshot). */
		epoch: z.string().max(128).optional(),
	}),
	"session.unsubscribe": z.object(SessionRef),
	"session.snapshot": z.object(SessionRef),

	"session.prompt": z.object({
		...SessionRef,
		text: Text,
		images: Images,
		streamingBehavior: StreamingBehaviorSchema.optional(),
	}),
	"session.steer": z.object({ ...SessionRef, text: Text, images: Images }),
	"session.followUp": z.object({ ...SessionRef, text: Text, images: Images }),
	"session.abort": z.object(SessionRef),
	"session.compact": z.object({ ...SessionRef, instructions: z.string().max(10_000).optional() }),

	"model.list": z.object({ sessionId: Id.optional() }).optional(),
	"model.set": z.object({ ...SessionRef, provider: Id, modelId: Id, persist: z.boolean().optional() }),
	"thinking.set": z.object({ ...SessionRef, level: ThinkingLevelSchema, persist: z.boolean().optional() }),
	"model.setDefault": z.object({ provider: Id, modelId: Id }),

	"provider.list": z.object({}).optional(),
	/** Start an interactive sign-in. Progress arrives as `auth.*` events on this connection. */
	"provider.login": z.object({ providerId: Id, method: AuthMethodSchema }),
	"provider.loginRespond": z.object({
		flowId: Id,
		promptId: Id,
		value: z.string().max(20_000).optional(),
		cancelled: z.boolean().optional(),
	}),
	"provider.loginCancel": z.object({ flowId: Id }),
	"provider.logout": z.object({ providerId: Id }),
	"provider.saveCustom": z.object({
		provider: CustomProviderSchema,
		/** Saved to auth.json. Omit to keep the existing key. */
		apiKey: z.string().trim().min(1).max(20_000).optional(),
		/** True when creating: fails if the id is already taken. */
		create: z.boolean().optional(),
	}),
	"provider.removeCustom": z.object({ providerId: Id }),
	/** List the models an endpoint offers (`GET /models`). Uses the saved key of `providerId` when `apiKey` is omitted. */
	"provider.probeModels": z.object({
		api: CustomProviderApiSchema,
		baseUrl: z.string().trim().min(1).max(2000),
		apiKey: z.string().trim().max(20_000).optional(),
		providerId: Id.optional(),
	}),

	"ui.respond": z.object({ ...SessionRef, requestId: Id, response: UiResponseSchema }),

	"device.list": z.object({}).optional(),
	"device.revoke": z.object({ deviceId: Id }),
	"device.rename": z.object({ deviceId: Id, name: z.string().trim().min(1).max(100) }),
	"pairing.start": z.object({}).optional(),
	"pairing.cancel": z.object({}).optional(),
	"pairing.respond": z.object({ requestId: Id, accept: z.boolean() }),

	"remote.status": z.object({}).optional(),
	"remote.configure": z.object({
		enabled: z.boolean().optional(),
		port: z.number().int().min(1024).max(65535).optional(),
	}),
} as const;

export type MethodName = keyof typeof MethodParamsSchemas;

export const METHOD_NAMES = Object.keys(MethodParamsSchemas) as MethodName[];

export function isMethodName(method: string): method is MethodName {
	return Object.hasOwn(MethodParamsSchemas, method);
}

/** Methods that only the local desktop UI may call. */
export const LOCAL_ONLY_METHODS: ReadonlySet<MethodName> = new Set([
	"device.list",
	"device.revoke",
	"device.rename",
	"pairing.start",
	"pairing.cancel",
	"pairing.respond",
	"remote.status",
	"remote.configure",
	"workspace.add",
	"workspace.remove",
	"workspace.setPolicy",
	"model.setDefault",
	"provider.list",
	"provider.login",
	"provider.loginRespond",
	"provider.loginCancel",
	"provider.logout",
	"provider.saveCustom",
	"provider.removeCustom",
	"provider.probeModels",
]);

export interface HelloResult {
	protocolVersion: string;
	host: HostInfo;
	connectionId: string;
	/** For remote connections: the paired device this connection authenticated as. */
	device?: { id: string; name: string };
}

export interface ForkPoint {
	entryId: string;
	text: string;
}

export interface SubscribeResult {
	/** `replay`: events after `sinceSeq` follow. `snapshot`: a `session.snapshot` event follows. */
	mode: "replay" | "snapshot";
	currentSeq: number;
	/** Identifies the event log instance; seqs from another epoch are meaningless. */
	epoch: string;
}

export interface MethodResults {
	"host.hello": HelloResult;
	"host.info": HostInfo;
	"workspace.list": { workspaces: WorkspaceInfo[] };
	"workspace.add": { workspace: WorkspaceInfo };
	"workspace.remove": { removed: boolean };
	"workspace.setPolicy": { workspace: WorkspaceInfo };
	"session.list": { sessions: SessionSummary[] };
	"session.create": { session: SessionSummary };
	"session.open": { session: SessionSummary };
	"session.close": { closed: boolean };
	"session.forkPoints": { points: ForkPoint[] };
	"session.fork": { session: SessionSummary; selectedText?: string };
	"session.rename": { session: SessionSummary };
	"session.subscribe": SubscribeResult;
	"session.unsubscribe": { unsubscribed: boolean };
	"session.snapshot": SessionSnapshot;
	"session.prompt": { accepted: true };
	"session.steer": { queue: QueueState };
	"session.followUp": { queue: QueueState };
	"session.abort": { aborted: true };
	"session.compact": { summary: string; tokensBefore: number };
	"model.list": { models: ModelInfo[]; current?: ModelInfo };
	"model.set": { model: ModelInfo };
	"thinking.set": { level: string };
	"model.setDefault": { defaultModel: DefaultModelRef };
	"provider.list": ProviderListResult;
	"provider.login": { flowId: string };
	"provider.loginRespond": { accepted: boolean };
	"provider.loginCancel": { cancelled: boolean };
	"provider.logout": { removed: boolean };
	"provider.saveCustom": { provider: ProviderInfo; defaultModel?: DefaultModelRef };
	"provider.removeCustom": { removed: boolean };
	"provider.probeModels": { models: Array<{ id: string; name?: string }> };
	"ui.respond": { accepted: boolean };
	"device.list": { devices: DeviceInfo[] };
	"device.revoke": { revoked: boolean };
	"device.rename": { device: DeviceInfo };
	"pairing.start": { uri: string; expiresAt: string; addresses: string[] };
	"pairing.cancel": { cancelled: boolean };
	"pairing.respond": { accepted: boolean };
	"remote.status": RemoteAccessStatus;
	"remote.configure": RemoteAccessStatus;
}

export type MethodParams<M extends MethodName> = z.input<(typeof MethodParamsSchemas)[M]>;
export type ParsedMethodParams<M extends MethodName> = z.output<(typeof MethodParamsSchemas)[M]>;
export type MethodResult<M extends MethodName> = MethodResults[M];
