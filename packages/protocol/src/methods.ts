import { z } from "zod";
import {
	type AccountLoginResult,
	type AccountOverview,
	type AccountStatus,
	ApprovalPolicySchema,
	AuthMethodSchema,
	type ClientInfo,
	type CustomModel,
	CustomProviderApiSchema,
	CustomProviderSchema,
	type DefaultModelRef,
	type DeviceInfo,
	type ExtensionListResult,
	type ExtensionPackageInfo,
	type ExtensionReloadSummary,
	type ExtensionResourceInfo,
	ExtensionResourceTypeSchema,
	ExtensionScopeSchema,
	type ExtensionUpdateInfo,
	type HostInfo,
	ImageInputSchema,
	type ModelInfo,
	type NewApiAuthorizeResult,
	type NewApiAuthorizeStart,
	type NewApiLoginResult,
	type NewApiModel,
	type NewApiToken,
	type ProviderInfo,
	type ProviderListResult,
	type QueueState,
	type RemoteAccessStatus,
	type SessionCommandInfo,
	type SessionSnapshot,
	type SessionSummary,
	StreamingBehaviorSchema,
	ThinkingLevelSchema,
	UiResponseSchema,
	type WorkspaceFileContent,
	type WorkspaceFilesResult,
	type WorkspaceFileWriteResult,
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
	/** List one directory of a workspace (1.5). `path` is relative to the workspace root; omit for the root. */
	"workspace.files": z.object({ workspaceId: Id, path: z.string().max(4096).optional() }),
	/** Read one workspace file for preview (1.7). `path` is relative to the workspace root. */
	"workspace.readFile": z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	/**
	 * Overwrite an existing workspace file with UTF-8 text (1.8). With `expectedModifiedAt`
	 * (the `modifiedAt` the client read), fails with `CONFLICT` if the file changed since.
	 */
	"workspace.writeFile": z.object({
		workspaceId: Id,
		path: z.string().min(1).max(4096),
		text: z.string().max(4 * 1024 * 1024),
		expectedModifiedAt: z.string().max(64).optional(),
	}),

	"session.list": z.object({ workspaceId: Id }),
	"session.create": z.object({ workspaceId: Id, name: z.string().min(1).max(200).optional() }),
	"session.open": z.union([
		z.object({ workspaceId: Id, sessionId: Id }),
		z.object({ workspaceId: Id, path: z.string().min(1).max(4096) }),
	]),
	"session.close": z.object({ ...SessionRef, force: z.boolean().optional() }),
	/** Close the session and move its file to Pier's trash (1.6). Running sessions need `force`. */
	"session.delete": z.object({ workspaceId: Id, sessionId: Id, force: z.boolean().optional() }),
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
	/** Slash commands the session's agent runtime handles in `session.prompt` (1.5). */
	"session.commands": z.object(SessionRef),
	/** Reload extensions, skills, prompt templates, themes, and context files (1.5). */
	"session.reload": z.object(SessionRef),

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
		/** A key held by the host (from `newapi.useToken`), used instead of `apiKey`. Added in 1.3. */
		apiKeyRef: Id.optional(),
		/** True when creating: fails if the id is already taken. */
		create: z.boolean().optional(),
	}),
	"provider.removeCustom": z.object({ providerId: Id }),
	/** List the models an endpoint offers (`GET /models`). Uses the saved key of `providerId` when `apiKey` is omitted. */
	"provider.probeModels": z.object({
		api: CustomProviderApiSchema,
		baseUrl: z.string().trim().min(1).max(2000),
		apiKey: z.string().trim().max(20_000).optional(),
		/** A key held by the host (from `newapi.useToken`). Added in 1.3. */
		apiKeyRef: Id.optional(),
		providerId: Id.optional(),
	}),

	/**
	 * Sign in to a NewAPI site (1.3), with a password or a system access token. The host keeps
	 * the login session in memory for this connection only.
	 */
	"newapi.login": z.union([
		z.object({
			baseUrl: z.string().trim().min(1).max(2000),
			username: z.string().trim().min(1).max(200),
			password: z.string().min(1).max(1000),
		}),
		z.object({
			baseUrl: z.string().trim().min(1).max(2000),
			accessToken: z.string().trim().min(1).max(2000),
			/** Numeric user id; older NewAPI versions require it next to an access token. */
			userId: z.number().int().positive().optional(),
		}),
	]),
	/** Answer the two-factor question of a `verify` login result. */
	"newapi.verify": z.object({ sessionId: Id, code: z.string().trim().min(1).max(100) }),
	"newapi.createToken": z.object({
		sessionId: Id,
		name: z.string().trim().min(1).max(50),
		group: z.string().max(100).optional(),
	}),
	/** Fetch the key of a token (kept on the host as `keyRef`) and the models it can use. */
	"newapi.useToken": z.object({ sessionId: Id, tokenId: z.number().int().positive() }),
	"newapi.close": z.object({ sessionId: Id }),
	/**
	 * Browser sign-in (1.4) for sites with NewAPI app authorization: the user signs in with any
	 * method and approves on the site, which creates a token for Pier. Only for local UIs,
	 * because the browser returns to a loopback address on the host's computer.
	 */
	"newapi.authorizeStart": z.object({ baseUrl: z.string().trim().min(1).max(2000) }),
	/** Resolve once the user approves (or reject when they decline, the flow expires or is cancelled). */
	"newapi.authorizeWait": z.object({ flowId: Id }),
	"newapi.authorizeCancel": z.object({ flowId: Id }),

	/**
	 * 云链API personal center (1.6). The host keeps one login for the site (saved in the Pier
	 * directory, so it survives restarts) and never hands its credentials or token keys to clients.
	 */
	"account.status": z.object({}).optional(),
	"account.login": z.union([
		z.object({ username: z.string().trim().min(1).max(200), password: z.string().min(1).max(1000) }),
		z.object({ accessToken: z.string().trim().min(1).max(2000), userId: z.number().int().positive().optional() }),
	]),
	"account.verify": z.object({ code: z.string().trim().min(1).max(100) }),
	/** Email a registration verification code. */
	"account.sendCode": z.object({ email: z.string().trim().min(3).max(50) }),
	/** Register with a password, then sign in. */
	"account.register": z.object({
		username: z.string().trim().min(1).max(20),
		password: z.string().min(8).max(128),
		email: z.string().trim().max(50).optional(),
		code: z.string().trim().max(100).optional(),
		/** Inviter's code. */
		affCode: z.string().trim().max(32).optional(),
	}),
	"account.overview": z.object({}).optional(),
	"account.createToken": z.object({ name: z.string().trim().min(1).max(50), group: z.string().max(100).optional() }),
	/** Fetch a token's key (kept on the host as `keyRef`, usable in `provider.saveCustom`) and its models. */
	"account.useToken": z.object({ tokenId: z.number().int().positive() }),
	"account.logout": z.object({}).optional(),

	/**
	 * pi extensions and packages (1.8). Without `workspaceId` only user settings
	 * (`<agentDir>/settings.json`) apply; with it, also that workspace's `.pi/settings.json`.
	 */
	"extension.list": z.object({ workspaceId: Id.optional() }).optional(),
	/** Install a pi package (`npm:<name>[@version]`, `git:<host>/<path>[@ref]`, a git URL, or an absolute path). */
	"extension.install": z.object({
		source: z.string().trim().min(1).max(4096),
		scope: ExtensionScopeSchema.optional(),
		workspaceId: Id.optional(),
	}),
	/** Remove a package from settings and uninstall it (npm / git). `source` as listed. */
	"extension.remove": z.object({
		source: z.string().min(1).max(4096),
		scope: ExtensionScopeSchema,
		workspaceId: Id.optional(),
	}),
	/** Update one package, or every unpinned package when `source` is omitted. */
	"extension.update": z
		.object({ source: z.string().min(1).max(4096).optional(), workspaceId: Id.optional() })
		.optional(),
	"extension.checkUpdates": z.object({ workspaceId: Id.optional() }).optional(),
	/** Enable or disable one listed resource in the settings of its own scope. */
	"extension.setEnabled": z.object({
		type: ExtensionResourceTypeSchema,
		path: z.string().min(1).max(4096),
		enabled: z.boolean(),
		workspaceId: Id.optional(),
	}),
	/**
	 * Delete a top-level extension: a file or directory in an `extensions` directory moves to
	 * Pier's trash; a settings path entry is removed from settings (the files stay).
	 */
	"extension.delete": z.object({ path: z.string().min(1).max(4096), workspaceId: Id.optional() }),

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
	"workspace.writeFile",
	"model.setDefault",
	"provider.list",
	"provider.login",
	"provider.loginRespond",
	"provider.loginCancel",
	"provider.logout",
	"provider.saveCustom",
	"provider.removeCustom",
	"provider.probeModels",
	"newapi.login",
	"newapi.verify",
	"newapi.createToken",
	"newapi.useToken",
	"newapi.close",
	"newapi.authorizeStart",
	"newapi.authorizeWait",
	"newapi.authorizeCancel",
	"account.status",
	"account.login",
	"account.verify",
	"account.sendCode",
	"account.register",
	"account.overview",
	"account.createToken",
	"account.useToken",
	"account.logout",
	"extension.list",
	"extension.install",
	"extension.remove",
	"extension.update",
	"extension.checkUpdates",
	"extension.setEnabled",
	"extension.delete",
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
	"workspace.files": WorkspaceFilesResult;
	"workspace.readFile": WorkspaceFileContent;
	"workspace.writeFile": WorkspaceFileWriteResult;
	"session.list": { sessions: SessionSummary[] };
	"session.create": { session: SessionSummary };
	"session.open": { session: SessionSummary };
	"session.close": { closed: boolean };
	"session.delete": { deleted: boolean };
	"session.forkPoints": { points: ForkPoint[] };
	"session.fork": { session: SessionSummary; selectedText?: string };
	"session.rename": { session: SessionSummary };
	"session.subscribe": SubscribeResult;
	"session.unsubscribe": { unsubscribed: boolean };
	"session.snapshot": SessionSnapshot;
	"session.commands": { commands: SessionCommandInfo[] };
	"session.reload": { reloaded: true };
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
	/** Capabilities pi's model catalog knows for an id are filled in (1.6). */
	"provider.probeModels": { models: CustomModel[] };
	"newapi.login": NewApiLoginResult;
	"newapi.verify": NewApiLoginResult;
	"newapi.createToken": { tokenId: number; tokens: NewApiToken[] };
	"newapi.useToken": {
		keyRef: string;
		/** Models the token can call (`GET /v1/models` with its key), with the detected wire API (1.7). */
		models: NewApiModel[];
		/** Why the model list could not be read, when it could not. */
		modelsError?: string;
	};
	"newapi.close": { closed: boolean };
	"newapi.authorizeStart": NewApiAuthorizeStart;
	"newapi.authorizeWait": NewApiAuthorizeResult;
	"newapi.authorizeCancel": { cancelled: boolean };
	"account.status": AccountStatus;
	"account.login": AccountLoginResult;
	"account.verify": AccountLoginResult;
	"account.sendCode": { sent: true };
	"account.register": AccountLoginResult;
	"account.overview": AccountOverview;
	"account.createToken": { tokenId: number; tokens: NewApiToken[] };
	"account.useToken": {
		keyRef: string;
		models: NewApiModel[];
		modelsError?: string;
	};
	"account.logout": { loggedOut: boolean };
	"extension.list": ExtensionListResult;
	"extension.install": { package?: ExtensionPackageInfo; reload: ExtensionReloadSummary };
	"extension.remove": { removed: boolean; reload: ExtensionReloadSummary };
	"extension.update": { reload: ExtensionReloadSummary };
	"extension.checkUpdates": { updates: ExtensionUpdateInfo[] };
	"extension.setEnabled": { resource: ExtensionResourceInfo; reload: ExtensionReloadSummary };
	"extension.delete": { deleted: boolean; reload: ExtensionReloadSummary };
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
