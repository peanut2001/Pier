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

/** One subdirectory in a `host.listDirectories` result (1.10). */
export interface HostDirectoryEntry {
	name: string;
	/** Absolute path on the host. */
	path: string;
	symlink?: boolean;
}

/** Subdirectories of one host directory, used to pick a workspace on another computer (1.10). */
export interface HostDirectoryListing {
	/** The listed directory: absolute and normalized (symlinks are not resolved). */
	path: string;
	/** Its parent directory; omitted at a filesystem root. */
	parent?: string;
	/** The host user's home directory. */
	home: string;
	/** Path separator on the host (`/` or `\\`). */
	separator: string;
	/** Subdirectories (symlinks to directories included), sorted by name. */
	entries: HostDirectoryEntry[];
	truncated?: boolean;
	total?: number;
}

/**
 * State of the desktop app's updater (`update.*`, 1.13):
 * - `unsupported`: the host does not run inside a packaged desktop app (a development build,
 *   a standalone `pier-host`, or a desktop app too old to be driven by its host).
 * - `idle`: not checked yet. `upToDate` / `available`: result of the last check.
 * - `downloading` / `installing`: an update is being installed; the app restarts when done.
 * - `error`: the last check or install failed (`error`); with `version` the update is still
 *   pending and installing can be retried.
 */
export type AppUpdateState =
	| "unsupported"
	| "idle"
	| "checking"
	| "upToDate"
	| "available"
	| "downloading"
	| "installing"
	| "error";

/** The desktop app's updater on the host's computer (1.13). */
export interface AppUpdateStatus {
	state: AppUpdateState;
	/** Version of the desktop app (the host's version when there is no desktop app). */
	currentVersion: string;
	/** The app checks for updates on its own. */
	autoCheck: boolean;
	/** The available (or still pending, after a failed install) version. */
	version?: string;
	/** Release notes of `version` (Markdown). */
	notes?: string;
	/** Publication date of `version` (ISO 8601). */
	date?: string;
	/** Bytes downloaded so far while `downloading`. */
	downloaded: number;
	total?: number;
	error?: string;
	/** Unix time (ms) of the last successful check. */
	lastChecked?: number;
	/**
	 * Installing asks for an administrator password on that computer (Linux `.deb` / `.rpm`
	 * installs), so someone has to be there to finish it.
	 */
	installNeedsAuth?: boolean;
}

/** Resource usage of the computer a host runs on (`host.stats`, 1.12). Sizes are bytes. */
export interface HostStats {
	/** When the host took the sample (ISO 8601). */
	sampledAt: string;
	/** Host OS (`darwin`, `linux`, `win32`, …). */
	platform: string;
	/** Seconds since the computer booted. */
	uptime: number;
	cpu: {
		/** Busy share of all cores since the previous sample, 0–1. */
		usage: number;
		/** Logical cores. */
		cores: number;
		model?: string;
		/** 1, 5 and 15 minute load averages (omitted on Windows). */
		loadAverage?: [number, number, number];
	};
	memory: {
		total: number;
		/** In use by programs (excludes reclaimable caches where the OS reports them). */
		used: number;
	};
	/** The filesystem holding the user's home directory; omitted when it cannot be read. */
	disk?: {
		/** The directory that was measured (the home directory). */
		path: string;
		total: number;
		used: number;
		/** Free space available to the user. */
		available: number;
	};
	/**
	 * Traffic of the physical network interfaces (all non-loopback ones when none is physical),
	 * omitted when the OS does not report it. Rates are bytes per second since the previous sample.
	 */
	network?: {
		rxRate: number;
		txRate: number;
		/** Bytes received / sent since the counters started (usually boot). */
		rxTotal: number;
		txTotal: number;
	};
	/** Memory of the Pier Host process (resident set size). */
	hostRss: number;
}

/** An npm-compatible package manager pi can use for `npmCommand`. */
export type PackageManagerName = "npm" | "pnpm" | "bun";

/** One package manager executable found on the host (`host.packageManagers`, 1.17). */
export interface PackageManagerInfo {
	name: PackageManagerName;
	/** Absolute path of the executable as found (not resolved through symlinks). */
	path: string;
	/** Found in a directory on the host's `PATH`, not only in a well-known install directory. */
	onPath: boolean;
	/** A bare `name` runs this one (the first of its name on the host's `PATH`). */
	default?: true;
	/** `--version` output, without a leading `v`; omitted when it could not be run (see `error`). */
	version?: string;
	/** Why `--version` failed (e.g. `node` is not on the host's `PATH` for npm). */
	error?: string;
}

export interface PackageManagerDetection {
	/** `PATH` order first, then the well-known install directories; one entry per real file. */
	managers: PackageManagerInfo[];
}

/** One entry of a workspace directory listing (`workspace.files`, 1.5). */
export interface WorkspaceFileEntry {
	name: string;
	/** Path relative to the workspace root, joined with "/". */
	path: string;
	/**
	 * `directory` can be listed with `workspace.files`. Symlinks are followed; a link to a
	 * directory outside the workspace, a broken link, or a special file is `other`.
	 */
	kind: "file" | "directory" | "other";
	symlink?: boolean;
	/** Size in bytes (files only). */
	size?: number;
	modifiedAt?: string;
}

export interface WorkspaceFilesResult {
	/** The listed directory, normalized ("" for the workspace root). */
	path: string;
	/** Directories first, then files, by name. VCS internals (`.git`, `.hg`, `.svn`) are omitted. */
	entries: WorkspaceFileEntry[];
	/** Set when the directory had more entries than the host returns. */
	truncated?: boolean;
	/** Total number of entries when `truncated`. */
	total?: number;
}

/** A workspace file read for preview (`workspace.readFile`, 1.7). */
export interface WorkspaceFileContent {
	/** Path relative to the workspace root, normalized and joined with "/". */
	path: string;
	/** Size in bytes of the file on disk. */
	size: number;
	modifiedAt: string;
	/**
	 * `text`: UTF-8 text in `text`. `image`: a common image format (by extension), base64 in
	 * `data` unless `tooLarge`. `binary`: anything else; no content is returned.
	 */
	kind: "text" | "image" | "binary";
	text?: string;
	/** Set when only the first part of a text file is returned in `text`. */
	truncated?: boolean;
	/** Base64 image data without the `data:` prefix. */
	data?: string;
	mimeType?: string;
	/** Set when an image is too large to return. */
	tooLarge?: boolean;
}

/** Result of `workspace.writeFile` (1.8): the file's metadata after writing. */
export interface WorkspaceFileWriteResult {
	/** Path relative to the workspace root, normalized and joined with "/". */
	path: string;
	/** Size in bytes of the file on disk. */
	size: number;
	modifiedAt: string;
}

/** Result of `workspace.deletePath` (1.11): what was deleted. */
export interface WorkspacePathDeleteResult {
	/** Path relative to the workspace root, normalized and joined with "/". */
	path: string;
	/** `directory` was deleted with its contents; `other` covers symbolic links and special files. */
	kind: "file" | "directory" | "other";
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
	/** Set when the session was archived with `session.archive` (1.14); absent otherwise. */
	archived?: boolean;
}

/** Which sessions `session.cleanup` affects by archive state (1.14). */
export type SessionCleanupScope = "all" | "archived" | "unarchived";

/** A session `session.cleanup` left alone (1.14). */
export interface SessionCleanupSkip {
	sessionId: string;
	/** `running`: busy or waiting for an answer. `locked`: open in another Pier host. `error`: see `message`. */
	reason: "running" | "locked" | "error";
	message?: string;
}

export interface SessionCleanupResult {
	/** Sessions that were (or, with `dryRun`, would be) archived or deleted. */
	sessionIds: string[];
	skipped: SessionCleanupSkip[];
}

export interface ModelInfo {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: string[];
	contextWindow?: number;
	/** Thinking levels the model supports, lowest first (1.19). `["off"]` for non-reasoning models. */
	thinkingLevels?: ThinkingLevel[];
}

/** Where a slash command offered by the host comes from (1.5). */
export type SessionCommandSource = "extension" | "prompt" | "skill";

/**
 * A slash command the agent runtime handles when it arrives as a prompt (1.5): extension
 * commands, prompt templates, and `skill:<name>` commands. `name` excludes the leading `/`.
 */
export interface SessionCommandInfo {
	name: string;
	description?: string;
	/** Usage hint for the arguments, e.g. `<file>`. */
	argumentHint?: string;
	source: SessionCommandSource;
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
	/**
	 * The host can run shells for its clients (`terminal.*`, 1.18): it runs inside a desktop app
	 * that provides pseudo-terminals. Absent on older hosts and headless ones.
	 */
	terminals?: boolean;
}

/** A shell `terminal.open` started on the host's computer (1.18). */
export interface TerminalInfo {
	terminalId: string;
	/** Shell program name, e.g. `zsh` or `powershell`. */
	shell: string;
	/** Directory the shell started in (the home directory when the requested one is missing). */
	cwd: string;
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

/**
 * Another computer's Pier Host that this host paired with as a device (1.9). The desktop UI
 * reaches it through the local gateway (`ws://127.0.0.1:<port>/peer/<id>`), which runs the
 * secure channel with this host's own key.
 */
export interface PeerInfo {
	/** The peer's host id. */
	id: string;
	/** The peer's host name (refreshed on every connection). */
	name: string;
	/** Fingerprint of the peer's host key, pinned at pairing. */
	fingerprint: string;
	/** Candidate `host:port` addresses, the last one that worked first. */
	addresses: string[];
	/** This computer's device id on the peer. */
	deviceId: string;
	pairedAt: string;
	lastConnectedAt?: string;
	/** The peer's OS (`darwin`, `linux`, `win32`) and Pier Host version, once connected. */
	platform?: string;
	version?: string;
	/** Whether a desktop window is connected to it right now. */
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

// ---- Model providers and credentials (1.2) ----------------------------------------------

export const AuthMethodSchema = z.enum(["api_key", "oauth"]);
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/** Wire APIs a custom (models.json) provider can speak. */
export const CUSTOM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;
export const CustomProviderApiSchema = z.enum(CUSTOM_PROVIDER_APIS);
export type CustomProviderApi = z.infer<typeof CustomProviderApiSchema>;

export const ProviderIdSchema = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, digits, '.', '_' or '-'");

export const CustomModelSchema = z.object({
	id: z.string().trim().min(1).max(200),
	name: z.string().trim().max(200).optional(),
	reasoning: z.boolean().optional(),
	/** Whether the model accepts image input. */
	images: z.boolean().optional(),
	contextWindow: z.number().int().positive().max(100_000_000).optional(),
	maxTokens: z.number().int().positive().max(100_000_000).optional(),
	/**
	 * Wire API of this model when it differs from the provider's, e.g. Claude models of a relay
	 * that are called with Anthropic Messages. The host derives the model's Base URL from the
	 * provider's. Added in 1.7.
	 */
	api: CustomProviderApiSchema.optional(),
});
export type CustomModel = z.infer<typeof CustomModelSchema>;

/** A model a NewAPI token can use, with the wire API the site says it supports best. */
export interface NewApiModel {
	id: string;
	name?: string;
	/** Detected from the site's `supported_endpoint_types` (or the model family on older sites). */
	api?: CustomProviderApi;
}

/** An OpenAI-, Anthropic- or Google-compatible endpoint stored in pi's `models.json`. */
export const CustomProviderSchema = z.object({
	id: ProviderIdSchema,
	name: z.string().trim().max(100).optional(),
	api: CustomProviderApiSchema,
	baseUrl: z
		.string()
		.trim()
		.max(2000)
		.regex(/^https?:\/\/\S+$/i, "Base URL must start with http:// or https://"),
	models: z.array(CustomModelSchema).min(1).max(500),
});
export type CustomProvider = z.infer<typeof CustomProviderSchema>;

export interface ProviderAuthStatus {
	configured: boolean;
	/** Which credential is in use when configured. */
	type?: AuthMethod;
	/** `stored` (auth.json), `environment`, `models_json_key`, `models_json_command`, `runtime`, ... */
	source?: string;
	/** Human readable source, e.g. an environment variable name. */
	label?: string;
}

/** A model provider known to the host: built in, from models.json, or registered by an extension. */
export interface ProviderInfo {
	id: string;
	name: string;
	/** Whether pi ships this provider. */
	builtin: boolean;
	/** API-key authentication. `interactive: false` means ambient-only (environment variables, cloud credentials). */
	apiKey?: { name: string; interactive: boolean };
	/** OAuth / subscription sign-in. */
	oauth?: { name: string; loginLabel?: string; subscription: boolean };
	status: ProviderAuthStatus;
	/** A credential for this provider is saved in auth.json (so it can be removed). */
	stored: boolean;
	modelCount: number;
	availableCount: number;
	/** Present when models.json defines this provider as a custom endpoint. Never contains secrets. */
	custom?: CustomProvider & { hasConfiguredKey: boolean };
}

export interface DefaultModelRef {
	provider: string;
	modelId: string;
}

export interface ProviderListResult {
	providers: ProviderInfo[];
	/** Default model for new sessions (pi global settings). */
	defaultModel?: DefaultModelRef;
	/** Whether the default model is currently usable. */
	defaultAvailable: boolean;
	/** Number of models with usable credentials. */
	availableCount: number;
	agentDir: string;
	/** models.json / composition problems reported by pi. */
	error?: string;
}

// ---- NewAPI sign-in (1.3) --------------------------------------------------------------

/** An API token (令牌) of a NewAPI account. The key itself never leaves the host. */
export interface NewApiToken {
	id: number;
	name: string;
	/** Masked key for display, e.g. `sk-abcd**********wxyz`. */
	maskedKey: string;
	/** NewAPI token status: 1 enabled, 2 disabled, 3 expired, 4 exhausted. */
	status: number;
	/** Empty for the user's default group. */
	group?: string;
	/** Unix seconds; absent when the token never expires. */
	expiresAt?: number;
	unlimitedQuota: boolean;
	remainQuota?: number;
	/** Models the token is restricted to, when model limits are enabled. */
	modelLimits?: string[];
}

/** A group the NewAPI user may create tokens in. */
export interface NewApiGroup {
	name: string;
	description?: string;
	/** Effective price ratio, or a label such as “自动”. */
	ratio?: number | string;
}

export interface NewApiAccount {
	site: {
		/** The site's `system_name`. */
		name: string;
		/** Normalized site address, e.g. `https://api.example.com`. */
		url: string;
		version?: string;
		logo?: string;
	};
	user: { id?: number; username: string; displayName?: string; group?: string };
	tokens: NewApiToken[];
	groups: NewApiGroup[];
}

/** Result of `newapi.authorizeStart` (1.4): open `authorizeUrl` in the user's browser. */
export interface NewApiAuthorizeStart {
	flowId: string;
	/** The site's consent page. The browser returns to a loopback address on the host. */
	authorizeUrl: string;
	site: NewApiAccount["site"];
	/** ISO time after which the flow is abandoned. */
	expiresAt: string;
}

/** Result of `newapi.authorizeWait` (1.4): the API token the user approved in the browser. */
export interface NewApiAuthorizeResult {
	site: NewApiAccount["site"];
	user: NewApiAccount["user"];
	token: { id: number; name: string; group?: string; maskedKey: string };
	/** Host-side reference to the token key, as from `newapi.useToken`. */
	keyRef: string;
	models: NewApiModel[];
	modelsError?: string;
}

/** Result of `newapi.login` / `newapi.verify`. */
export type NewApiLoginResult =
	| { status: "ok"; sessionId: string; account: NewApiAccount }
	/** The account asks for a two-factor code; answer with `newapi.verify`. */
	| { status: "verify"; sessionId: string; methods: string[] };

// ---- 云链API account (1.6) ------------------------------------------------------------

/** The 云链API site the personal center connects to. */
export const YUNLIAN_SITE_URL = "https://api.yunnet.top";

/** How the site shows amounts of quota (NewAPI `quota_per_unit`, `quota_display_type` and friends). */
export interface AccountQuotaDisplay {
	/** Quota units per US dollar. */
	perUnit: number;
	/** `USD`, `CNY`, `CUSTOM` or `TOKENS` (raw quota). */
	type: string;
	/** CNY per US dollar, for `CNY`. */
	usdRate?: number;
	/** Symbol and rate per US dollar, for `CUSTOM`. */
	customSymbol?: string;
	customRate?: number;
}

export interface AccountSite {
	name: string;
	url: string;
	version?: string;
	logo?: string;
	/** Whether new accounts may be registered with a password. */
	registerEnabled: boolean;
	/** Registration needs an email verification code (`account.sendCode`). */
	emailVerification: boolean;
	passwordLogin: boolean;
	/**
	 * The site can sign Pier in through the browser (NewAPI app authorization with the `account`
	 * scope, 1.11): `account.authorizeStart`. Every sign-in method of the website works there.
	 */
	browserLogin: boolean;
	/** Password sign-in and registration need a Turnstile check, which only the website can do. */
	turnstile: boolean;
	/** Third-party sign-in methods the website offers, e.g. `GitHub`, `LinuxDO`. */
	oauth: string[];
	quota: AccountQuotaDisplay;
}

/** The signed-in user, with the balance from `/api/user/self`. */
export interface AccountUser {
	id?: number;
	username: string;
	displayName?: string;
	email?: string;
	/** The user's own group (tokens without a group use it). */
	group?: string;
	/** Remaining quota in site units (see `AccountQuotaDisplay`). */
	quota: number;
	usedQuota: number;
	requestCount: number;
}

/** Result of `account.status`. */
export interface AccountStatus {
	site?: AccountSite;
	/** Why the site information could not be read, when it could not. */
	siteError?: string;
	/** The saved login, if any. Details and balance come from `account.overview`. */
	user?: NewApiAccount["user"];
}

export interface AccountOverview {
	site: AccountSite;
	user: AccountUser;
	tokens: NewApiToken[];
	groups: NewApiGroup[];
}

/** Result of `account.authorizeStart` (1.11): open `authorizeUrl` in the user's browser. */
export interface AccountAuthorizeStart {
	flowId: string;
	/** The site's sign-in consent page. The browser returns to a loopback address on the host. */
	authorizeUrl: string;
	/** ISO time after which the flow is abandoned. */
	expiresAt: string;
}

/** Result of `account.login`, `account.verify`, `account.register` and `account.authorizeWait`. */
export type AccountLoginResult =
	| { status: "ok"; overview: AccountOverview }
	/** The account asks for a two-factor code; answer with `account.verify`. */
	| { status: "verify"; methods: string[] };

/** A question asked during a provider sign-in. */
export interface AuthPromptInfo {
	id: string;
	type: "text" | "secret" | "select" | "manual_code";
	message: string;
	placeholder?: string;
	options?: Array<{ id: string; label: string; description?: string }>;
}

/** Progress information shown during a provider sign-in. */
export type AuthNotice =
	| { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

// ---- pi extensions and packages (1.8) ---------------------------------------------------

/** Resource kinds pi loads from packages and resource directories. */
export const ExtensionResourceTypeSchema = z.enum(["extensions", "skills", "prompts", "themes"]);
export type ExtensionResourceType = z.infer<typeof ExtensionResourceTypeSchema>;

/** `user`: `<agentDir>/settings.json` (every workspace). `project`: `<workspace>/.pi/settings.json`. */
export const ExtensionScopeSchema = z.enum(["user", "project"]);
export type ExtensionScope = z.infer<typeof ExtensionScopeSchema>;

/** A pi package declared in `packages` of a settings file. */
export interface ExtensionPackageInfo {
	/** The source exactly as written in settings (`npm:…`, `git:…`, a URL, or a path). */
	source: string;
	scope: ExtensionScope;
	kind: "npm" | "git" | "local";
	/** The settings entry narrows which resources load (object form with filters). */
	filtered: boolean;
	/** Where the package lives on disk; undefined when it is not installed (or the path is missing). */
	installedPath?: string;
	/** From the package's `package.json`, when it has one. */
	name?: string;
	version?: string;
	description?: string;
}

/** One extension, skill, prompt template, or theme that pi discovers. */
export interface ExtensionResourceInfo {
	type: ExtensionResourceType;
	/** Absolute path of the resource file (`SKILL.md` for skills, `index.ts` for directory extensions). */
	path: string;
	/** Short display name (file name, `dir/index.ts`, or the skill directory). */
	name: string;
	/** Whether pi loads it. Disabled resources are listed so they can be enabled again. */
	enabled: boolean;
	/** Settings file the resource belongs to. */
	scope: ExtensionScope;
	/** `package`: from a pi package. `top-level`: a resource directory or a settings path entry. */
	origin: "package" | "top-level";
	/** Package source for `package`; `auto` (resource directory) or `local` (settings entry) for `top-level`. */
	source: string;
	/** Can be removed with `extension.delete` (top-level extensions only). */
	deletable: boolean;
}

export interface ExtensionListResult {
	/** The pi agent directory holding the user settings. */
	agentDir: string;
	/** The workspace whose project settings were included, if any. */
	workspaceId?: string;
	packages: ExtensionPackageInfo[];
	resources: ExtensionResourceInfo[];
}

export interface ExtensionUpdateInfo {
	source: string;
	name: string;
	kind: "npm" | "git";
	scope: ExtensionScope;
}

// ---- pi package catalog (1.20) ----------------------------------------------------------

/** Resource kinds the pi package gallery (https://pi.dev/packages) tags packages with. */
export const ExtensionCatalogTypeSchema = z.enum(["extension", "skill", "theme", "prompt"]);
export type ExtensionCatalogType = z.infer<typeof ExtensionCatalogTypeSchema>;

/** Catalog order: most monthly downloads, most recently published, or by name. */
export const ExtensionCatalogSortSchema = z.enum(["downloads", "recent", "name"]);
export type ExtensionCatalogSort = z.infer<typeof ExtensionCatalogSortSchema>;

/** A package published to npm for pi (keyword `pi-package`), as listed by the gallery. */
export interface ExtensionCatalogPackage {
	/** npm package name. */
	name: string;
	/** What to pass to `extension.install` (`npm:<name>`). */
	source: string;
	description?: string;
	/** Latest published version. */
	version?: string;
	/** Publisher / author name. */
	author?: string;
	/** Resource kinds the package ships; empty when the gallery does not know. */
	types: ExtensionCatalogType[];
	monthlyDownloads?: number;
	/** When the latest version was published (ISO 8601). */
	publishedAt?: string;
	npmUrl: string;
	repositoryUrl?: string;
	/** The package's page in the pi gallery. */
	galleryUrl?: string;
}

export interface ExtensionCatalogResult {
	/** `pi.dev`: the official gallery. `npm`: the npm registry search (when the gallery is unreachable). */
	origin: "pi.dev" | "npm";
	packages: ExtensionCatalogPackage[];
	/** Matching packages in total. */
	total: number;
	page: number;
	pageSize: number;
	hasMore: boolean;
	/** Why the gallery was not used (with `origin: "npm"`). */
	notice?: string;
}

/** How open sessions picked up an extension change (1.8). */
export interface ExtensionReloadSummary {
	/** Idle sessions that were reloaded. */
	reloaded: number;
	/** Busy sessions left alone; they need `/reload` (`session.reload`) once idle. */
	pending: number;
	/** Sessions whose reload failed (see the host log). */
	failed: number;
}

// ---- pi settings files (1.15) -------------------------------------------------------------

/** One pi settings file: `<agentDir>/settings.json` (`user`) or `<workspace>/.pi/settings.json` (`project`). */
export interface PiSettingsFile {
	scope: ExtensionScope;
	/** Absolute path of the file. */
	path: string;
	/** The file exists (a missing file means every setting is at its default). */
	exists: boolean;
	/** The file's text as stored (without a byte-order mark); `""` when it does not exist. */
	text: string;
	/** The parsed settings; undefined when the text is not a JSON object (see `error`). */
	settings?: Record<string, unknown>;
	/** Why the text could not be parsed as a JSON object. */
	error?: string;
	/** Last modification time (ISO 8601), for `settings.write`'s `expectedModifiedAt`. */
	modifiedAt?: string;
}

export interface PiSettingsResult {
	/** The pi agent directory holding the user settings. */
	agentDir: string;
	user: PiSettingsFile;
	/** The workspace's project settings, when `workspaceId` was given. */
	project?: PiSettingsFile & { workspaceId: string };
}

/** Result of changing a settings file. */
export interface PiSettingsChangeResult {
	file: PiSettingsFile;
	/** False when the change left the file as it was (nothing was written or reloaded). */
	changed: boolean;
	reload: ExtensionReloadSummary;
}
