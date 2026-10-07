import {
	constants,
	createCipheriv,
	createHash,
	publicEncrypt,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import {
	type CustomProviderApi,
	type LoopbackCallbackPage,
	type NewApiAccount,
	type NewApiAuthorizeResult,
	type NewApiAuthorizeStart,
	type NewApiGroup,
	type NewApiLoginResult,
	type NewApiModel,
	type NewApiToken,
	PierProtocolError,
} from "@pier/protocol";
import { callbackPage, isLoopbackRedirect } from "../oauth-loopback.ts";

/**
 * Sign-in to NewAPI (https://github.com/QuantumNous/new-api) sites: log in with a password
 * (optionally with a two-factor code) or a system access token, list and create API tokens,
 * and read a token's key so it can be saved as a custom provider without the key ever
 * reaching the client.
 *
 * Supports both the current dashboard auth (login returns a Bearer access token) and the
 * older cookie session that needs a `New-Api-User` header.
 *
 * Sites that enable NewAPI app authorization can also be signed in through the browser
 * (`authorizeStart` / `authorizeWait`): the OAuth 2.0 authorization code flow for native apps
 * (RFC 8252) with a loopback redirect and PKCE (RFC 7636). The user signs in on the site with
 * any method it offers, approves a new token on its consent page, and the host exchanges the
 * returned code for the token key. Sites that also offer the `account` scope let the user sign
 * Pier in to the account the same way (`authorizeSessionStart` / `authorizeSessionWait`): the
 * code exchanges for a login session of Pier's own, used like a password login.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** Login sessions and key references expire after this long without use. */
const SESSION_TTL_MS = 30 * 60_000;
const TOKEN_PAGE_SIZE = 100;
const TOKEN_MAX_PAGES = 10;
/** How long a browser authorization may take before it is abandoned. */
const AUTHORIZE_TTL_MS = 10 * 60_000;
/** Name shown to the user on the site's consent page. */
const AUTHORIZE_CLIENT_NAME = "Pier";

interface Envelope {
	success?: boolean;
	message?: string;
	code?: string;
	data?: unknown;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		return cause instanceof Error && cause.message && !error.message.includes(cause.message)
			? `${error.message}: ${cause.message}`
			: error.message;
	}
	return String(error);
}

const fail = (message: string): never => {
	throw new PierProtocolError("BAD_REQUEST", message);
};

/** The site no longer accepts the login (it expired, was revoked, or the credentials changed). */
export class NewApiSessionExpired extends PierProtocolError {
	constructor(message: string) {
		super("BAD_REQUEST", message);
	}
}

/** Cookie holding the rotating refresh token of a dashboard login (current versions). */
const REFRESH_COOKIE = "new_api_refresh";
/** Refresh errors meaning the login is gone (expired, revoked, or the credentials changed). */
const DEAD_LOGIN_CODES: ReadonlySet<string> = new Set([
	"AUTH_UNAUTHORIZED",
	"AUTH_SESSION_REVOKED",
	"AUTH_TOKEN_EXPIRED",
]);
/** Renew the dashboard access token this long before it expires. */
const RENEW_MARGIN_MS = 60_000;

/** Unix seconds (or milliseconds) from the site as milliseconds. */
const epochMs = (value: unknown): number | undefined => {
	const n = num(value);
	if (n === undefined || n <= 0) return undefined;
	return n < 1e12 ? n * 1000 : n;
};

/**
 * Normalize what a user may paste as the site address: add a scheme, drop the query, and
 * strip API or dashboard paths such as `/v1`, `/console/token`, or `/login`.
 */
export function normalizeNewApiUrl(input: string): string {
	let text = input.trim();
	if (!text) fail("请填写 NewAPI 站点地址");
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		return fail(`无效的站点地址：${input}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") fail("站点地址必须以 http:// 或 https:// 开头");
	let path = url.pathname.replace(/\/+$/, "");
	path = path.replace(
		/\/(?:v1|v1beta|api|console|login|register|token|keys|panel|pricing|playground|chat|setting|topup|log)(?:\/.*)?$/i,
		"",
	);
	return `${url.origin}${path.replace(/\/+$/, "")}`;
}

/** Encrypt a password the way the NewAPI web client does (`v2`: RSA-OAEP-SHA256 wrapped AES-256-GCM). */
export function encryptNewApiPassword(password: string, publicKeyPem: string, keyId: string): string {
	const secret = randomBytes(32);
	const nonce = randomBytes(12);
	const wrapped = publicEncrypt(
		{
			key: publicKeyPem,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
			oaepLabel: Buffer.from("password-v2"),
		},
		secret,
	);
	const cipher = createCipheriv("aes-256-gcm", secret, nonce);
	cipher.setAAD(Buffer.from(`password-v2:${keyId}`));
	const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final(), cipher.getAuthTag()]);
	return ["v2", wrapped.toString("base64"), nonce.toString("base64"), ciphertext.toString("base64")].join(".");
}

const CLAUDE_MODEL = /(?:^|[/:._-])claude(?:$|[/:._-])/i;

/**
 * The wire API to call a model of a NewAPI site with.
 *
 * Current versions list `supported_endpoint_types` for each model (the union over the channels
 * that serve it): Anthropic channels offer `anthropic` and `openai`, Gemini channels `gemini` and
 * `openai`, Codex channels only `openai-response`, and pass-through channels (another NewAPI or
 * Sub2API) every type. Claude models prefer Anthropic Messages, everything else stays on Chat
 * Completions when the site offers it. Older versions do not list endpoint types, so Claude
 * models are recognised by name. Undefined means no preference (the provider's API is used).
 */
export function detectNewApiModelApi(id: string, endpointTypes: unknown): CustomProviderApi | undefined {
	const types = Array.isArray(endpointTypes)
		? endpointTypes.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
		: [];
	const claude = CLAUDE_MODEL.test(id);
	if (!types.length) return claude ? "anthropic-messages" : undefined;
	const has = (type: string) => types.includes(type);
	if (has("anthropic") && (claude || (!has("openai") && !has("openai-response")))) return "anthropic-messages";
	if (has("openai")) return "openai-completions";
	if (has("openai-response")) return "openai-responses";
	if (has("anthropic")) return "anthropic-messages";
	if (has("gemini")) return "google-generative-ai";
	return undefined;
}

/** Masked display form of a token key (lists of recent versions are already masked). */
function maskKey(key: string): string {
	const bare = key.replace(/^sk-/, "");
	if (bare.includes("*") || bare.length <= 8) return `sk-${bare}`;
	return `sk-${bare.slice(0, 4)}${"*".repeat(10)}${bare.slice(-4)}`;
}

const fullKey = (key: string) => (key.startsWith("sk-") ? key : `sk-${key}`);

interface RawToken {
	token: NewApiToken;
	/** Full key when the site still returns it in lists (older versions). */
	key?: string;
}

function toToken(raw: Json): RawToken | undefined {
	const id = num(raw.id);
	if (!id) return undefined;
	const key = str(raw.key) ?? "";
	const expired = num(raw.expired_time);
	const limits = str(raw.model_limits);
	const token: NewApiToken = {
		id,
		name: str(raw.name) ?? `#${id}`,
		maskedKey: key ? maskKey(key) : "",
		status: num(raw.status) ?? 1,
		unlimitedQuota: raw.unlimited_quota === true,
		...(str(raw.group) ? { group: str(raw.group) } : {}),
		...(expired !== undefined && expired > 0 ? { expiresAt: expired } : {}),
		...(raw.unlimited_quota !== true && num(raw.remain_quota) !== undefined
			? { remainQuota: num(raw.remain_quota) }
			: {}),
		...(raw.model_limits_enabled === true && limits
			? {
					modelLimits: limits
						.split(",")
						.map((m) => m.trim())
						.filter(Boolean),
				}
			: {}),
	};
	return { token, ...(key && !key.includes("*") ? { key: fullKey(key) } : {}) };
}

/** What a request needs from a login. */
interface Conn {
	origin: string;
	bearer?: string | undefined;
	userId?: number | undefined;
	cookies: Map<string, string>;
	/** Set for dashboard logins whose access token can be renewed with the refresh cookie. */
	renew?: Renewal | undefined;
}

interface Renewal {
	/** When the current access token expires (ms), if known. */
	accessExpiresAt?: number | undefined;
	pending?: Promise<void> | undefined;
	/** Called after the tokens changed, e.g. to persist them. */
	onChange?: (() => void) | undefined;
}

interface Session extends Conn {
	id: string;
	connectionId: string;
	status: Json;
	/** Whether `bearer` came from our own password login (and may be revoked on close). */
	ownLogin: boolean;
	/** Pending two-factor verification. */
	verify?: { kind: "flow"; flowToken: string } | { kind: "legacy" };
	user?: NewApiAccount["user"];
	keys: Map<number, string>;
	expiresAt: number;
}

/** What a browser authorization asks for: one API token, or a login session for the account. */
type AuthorizeScope = "token" | "account";

type SessionLoginResult = Extract<NewApiLoginResult, { status: "ok" }>;

interface AuthorizeFlow {
	id: string;
	scope: AuthorizeScope;
	connectionId: string;
	origin: string;
	status: Json;
	state: string;
	verifier: string;
	redirectUri: string;
	/**
	 * Listens for the redirect on this computer; undefined when the client catches it on its own
	 * computer and hands it over with `authorizeSessionCallback`.
	 */
	server?: Server;
	timer: ReturnType<typeof setTimeout>;
	/** Set once a callback carrying the right state arrived; later callbacks are ignored. */
	answered: boolean;
	ended: boolean;
	result: Promise<NewApiAuthorizeResult | SessionLoginResult>;
	resolve(result: NewApiAuthorizeResult | SessionLoginResult): void;
	reject(error: Error): void;
}

/** Whether the site's app authorization can sign apps in to the account (not only hand out tokens). */
export function supportsAccountScope(status: Json): boolean {
	return (
		status.app_authorization_enabled === true &&
		Array.isArray(status.app_authorization_scopes) &&
		status.app_authorization_scopes.includes("account")
	);
}

const sameSecret = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

/** A login taken over with `detach`, owned by the caller instead of a connection. */
export type NewApiSession = Session;

/** What `save` returns and `restore` accepts: enough to resume a login after a restart. */
export interface SavedNewApiSession {
	origin: string;
	ownLogin: boolean;
	userId?: number;
	user?: NewApiAccount["user"];
	/** A system access token (never a short-lived dashboard token). */
	bearer?: string;
	cookies?: Record<string, string>;
}

interface KeyRef {
	key: string;
	connectionId: string;
	expiresAt: number;
}

export interface NewApiManagerOptions {
	log?: (message: string) => void;
	/** Sent with every request to the site, e.g. so its login sessions list names Pier. */
	userAgent?: string;
	/** Override for tests. */
	fetch?: typeof fetch;
	now?: () => number;
}

export class NewApiManager {
	private readonly sessions = new Map<string, Session>();
	private readonly keyRefs = new Map<string, KeyRef>();
	private readonly flows = new Map<string, AuthorizeFlow>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;

	constructor(private readonly options: NewApiManagerOptions = {}) {
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	// ---- HTTP ------------------------------------------------------------------------------

	/** A request with the login of `session`, renewing its access token when needed. */
	private async call(
		session: Conn,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		options: { headers?: Record<string, string>; allowUnauthorized?: boolean } = {},
	): Promise<Envelope> {
		const renew = session.renew;
		if (!renew) return this.send(session, method, path, body, options);
		if (
			!session.bearer ||
			(renew.accessExpiresAt !== undefined && this.now() >= renew.accessExpiresAt - RENEW_MARGIN_MS)
		) {
			await this.renew(session, renew);
		}
		try {
			return await this.send(session, method, path, body, options);
		} catch (error) {
			if (!(error instanceof NewApiSessionExpired) || session.renew !== renew) throw error;
			// The access token was rejected early (e.g. the site restarted): renew once and retry.
			await this.renew(session, renew, true);
			return this.send(session, method, path, body, options);
		}
	}

	/** Get a new access token with the refresh cookie (the site rotates the cookie as well). */
	private renew(session: Conn, renewal: Renewal, force = false): Promise<void> {
		if (renewal.pending) return renewal.pending;
		if (
			!force &&
			session.bearer &&
			renewal.accessExpiresAt !== undefined &&
			this.now() < renewal.accessExpiresAt - RENEW_MARGIN_MS
		) {
			return Promise.resolve();
		}
		renewal.pending = (async () => {
			try {
				if (!session.cookies.get(REFRESH_COOKIE)) throw new NewApiSessionExpired("NewAPI 登录已失效，请重新登录");
				const envelope = await this.send(
					{ origin: session.origin, userId: session.userId, cookies: session.cookies },
					"POST",
					"/api/user/auth/refresh",
					undefined,
					{ headers: { origin: session.origin }, allowUnauthorized: true },
				);
				const data = envelope.success === true && isObject(envelope.data) ? envelope.data : undefined;
				const token = data ? str(data.access_token) : undefined;
				if (!data || !token) {
					// Only these mean the login is gone; others (origin refused, races, server errors) are transient.
					if (envelope.code && !DEAD_LOGIN_CODES.has(envelope.code)) {
						fail(
							`NewAPI：刷新登录失败（${envelope.code}${envelope.message ? `，${envelope.message}` : ""}），请稍后再试`,
						);
					}
					session.renew = undefined;
					session.bearer = undefined;
					renewal.onChange?.();
					throw new NewApiSessionExpired(
						`NewAPI 登录已失效，请重新登录${envelope.message ? `（${envelope.message}）` : ""}`,
					);
				}
				session.bearer = token;
				renewal.accessExpiresAt = epochMs(data.access_expires_at);
				renewal.onChange?.();
			} finally {
				renewal.pending = undefined;
			}
		})();
		return renewal.pending;
	}

	private async send(
		session: Conn,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		options: { headers?: Record<string, string>; allowUnauthorized?: boolean } = {},
	): Promise<Envelope> {
		const url = `${session.origin}${path}`;
		const headers: Record<string, string> = {
			accept: "application/json",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.5",
			...(this.options.userAgent ? { "user-agent": this.options.userAgent } : {}),
			...options.headers,
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		if (session.bearer) headers.authorization = `Bearer ${session.bearer}`;
		if (session.userId) headers["new-api-user"] = String(session.userId);
		if (session.cookies.size) {
			headers.cookie = [...session.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
		}
		let response: Response;
		try {
			response = await this.fetchImpl(url, {
				method,
				headers,
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				redirect: "follow",
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			return fail(`无法连接 ${session.origin}：${errorText(error)}`);
		}
		for (const cookie of response.headers.getSetCookie?.() ?? []) {
			const pair = cookie.split(";", 1)[0] ?? "";
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			if (value && !/max-age=0\b/i.test(cookie)) session.cookies.set(name, value);
			else session.cookies.delete(name);
		}
		const text = await response.text().catch(() => "");
		let envelope: Envelope | undefined;
		try {
			const parsed: unknown = JSON.parse(text);
			if (isObject(parsed)) envelope = parsed as Envelope;
		} catch {
			// handled below
		}
		if (response.status === 429) fail("NewAPI 请求过于频繁，请稍后再试");
		if (!envelope) {
			if (!response.ok) fail(`${url} 返回 HTTP ${response.status}`);
			return fail(`${url} 返回的不是 JSON，请确认这是 NewAPI 站点地址`);
		}
		if (response.status === 401 && !options.allowUnauthorized) {
			throw new NewApiSessionExpired(
				`NewAPI 登录已失效，请重新登录${envelope.message ? `（${envelope.message}）` : ""}`,
			);
		}
		if (!response.ok && envelope.success === undefined) fail(`${url} 返回 HTTP ${response.status}`);
		return { ...envelope, ...(response.ok ? {} : { success: false }) };
	}

	/** `call` that throws the site's message unless it reports success. */
	private async ok(session: Conn, method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
		const envelope = await this.call(session, method, path, body);
		if (envelope.success !== true) fail(`NewAPI：${envelope.message || "请求失败"}`);
		return envelope.data;
	}

	// ---- sessions --------------------------------------------------------------------------

	private sweep(): void {
		const now = this.now();
		for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.drop(id);
		for (const [ref, entry] of this.keyRefs) if (entry.expiresAt <= now) this.keyRefs.delete(ref);
	}

	private session(connectionId: string, sessionId: string): Session {
		this.sweep();
		const session = this.sessions.get(sessionId);
		if (!session || session.connectionId !== connectionId) {
			throw new PierProtocolError("NOT_FOUND", "NewAPI 登录已过期，请重新登录");
		}
		session.expiresAt = this.now() + SESSION_TTL_MS;
		return session;
	}

	private drop(sessionId: string): Session | undefined {
		const session = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		return session;
	}

	/** The site's public `/api/status`. */
	async siteStatus(origin: string): Promise<Json> {
		const envelope = await this.call({ origin, cookies: new Map() }, "GET", "/api/status");
		if (envelope.success !== true || !isObject(envelope.data)) {
			fail(`${origin} 不像是 NewAPI 站点（/api/status 没有返回站点信息）`);
		}
		return envelope.data as Json;
	}

	async login(
		connectionId: string,
		params: { baseUrl: string } & (
			| { username: string; password: string }
			| { accessToken: string; userId?: number | undefined }
		),
	): Promise<NewApiLoginResult> {
		this.sweep();
		const origin = normalizeNewApiUrl(params.baseUrl);
		const status = await this.siteStatus(origin);
		const session: Session = {
			id: randomUUID(),
			connectionId,
			origin,
			status,
			ownLogin: false,
			cookies: new Map(),
			keys: new Map(),
			expiresAt: this.now() + SESSION_TTL_MS,
		};

		if ("accessToken" in params) {
			session.bearer = params.accessToken.trim();
			if (params.userId) session.userId = params.userId;
			const self = await this.call(session, "GET", "/api/user/self", undefined, { allowUnauthorized: true });
			if (self.success !== true || !isObject(self.data)) {
				const message = self.message || "访问令牌无效";
				if (/New-Api-User/i.test(message) && !session.userId) {
					fail("这个 NewAPI 版本还需要用户 ID（个人设置页面可以看到），请一并填写");
				}
				fail(`NewAPI：${message}`);
			}
			this.setUser(session, self.data as Json);
			return this.finish(session);
		}

		if (status.password_login_enabled === false) {
			fail("该站点关闭了密码登录，请改用「访问令牌」方式（个人设置 → 系统访问令牌）");
		}
		if (status.turnstile_check === true) {
			fail("该站点开启了 Turnstile 人机验证，无法在 Pier 中直接用密码登录，请改用「访问令牌」方式");
		}
		let credentials: Json = { password: params.password };
		if (status.password_login_encryption_enabled === true) {
			const key = await this.ok(session, "GET", "/api/user/login/encryption-key");
			const kid = isObject(key) ? str(key.kid) : undefined;
			const publicKey = isObject(key) ? str(key.public_key) : undefined;
			if (!kid || !publicKey) return fail("NewAPI 没有返回登录加密公钥");
			try {
				credentials = {
					password_encrypted: encryptNewApiPassword(params.password, publicKey, kid),
					encryption_key_id: kid,
				};
			} catch (error) {
				return fail(`加密登录密码失败：${errorText(error)}`);
			}
		}
		const envelope = await this.call(
			session,
			"POST",
			"/api/user/login",
			{ username: params.username, ...credentials },
			{ allowUnauthorized: true },
		);
		if (envelope.success !== true) fail(`NewAPI：${envelope.message || "登录失败"}`);
		return this.afterLogin(session, envelope.data);
	}

	async verify(connectionId: string, sessionId: string, code: string): Promise<NewApiLoginResult> {
		const session = this.session(connectionId, sessionId);
		const pending = session.verify;
		if (!pending) throw new PierProtocolError("CONFLICT", "当前登录不需要验证码");
		const lenient = { allowUnauthorized: true };
		const envelope =
			pending.kind === "flow"
				? await this.call(
						session,
						"POST",
						"/api/user/login/verify",
						{ flow_token: pending.flowToken, method: "2fa", code: code.trim() },
						lenient,
					)
				: await this.call(session, "POST", "/api/user/login/2fa", { code: code.trim() }, lenient);
		if (envelope.success !== true) fail(`NewAPI：${envelope.message || "验证码错误"}`);
		session.verify = undefined;
		return this.afterLogin(session, envelope.data);
	}

	private async afterLogin(session: Session, data: unknown): Promise<NewApiLoginResult> {
		const body = isObject(data) ? data : {};
		if (body.require_verification === true) {
			const flowToken = str(body.flow_token);
			if (!flowToken) return fail("NewAPI 要求安全验证，但没有返回验证流程");
			const methods = (Array.isArray(body.methods) ? body.methods : [])
				.filter(isObject)
				.filter((m) => m.available !== false)
				.map((m) => str(m.method))
				.filter((m): m is string => Boolean(m));
			if (!methods.includes("2fa")) {
				fail("该账号登录需要 Passkey 等 Pier 暂不支持的验证方式，请改用「访问令牌」方式");
			}
			session.verify = { kind: "flow", flowToken };
			this.sessions.set(session.id, session);
			return { status: "verify", sessionId: session.id, methods: ["2fa"] };
		}
		if (body.require_2fa === true) {
			session.verify = { kind: "legacy" };
			this.sessions.set(session.id, session);
			return { status: "verify", sessionId: session.id, methods: ["2fa"] };
		}
		const accessToken = str(body.access_token);
		if (accessToken) {
			session.bearer = accessToken;
			session.ownLogin = true;
			if (session.cookies.has(REFRESH_COOKIE)) session.renew = { accessExpiresAt: epochMs(body.access_expires_at) };
			this.setUser(session, isObject(body.user) ? body.user : {});
		} else {
			// Older versions: a cookie session plus the user id in `New-Api-User`.
			this.setUser(session, body);
		}
		if (!session.userId && !session.bearer) fail("NewAPI 登录成功，但没有返回用户信息");
		return this.finish(session);
	}

	private setUser(session: Session, raw: Json): void {
		const id = num(raw.id);
		if (id) session.userId = id;
		session.user = {
			...(id ? { id } : {}),
			username: str(raw.username) ?? (id ? `#${id}` : "用户"),
			...(str(raw.display_name) ? { displayName: str(raw.display_name) } : {}),
			...(str(raw.group) ? { group: str(raw.group) } : {}),
		};
	}

	private async finish(session: Session): Promise<NewApiLoginResult> {
		this.sessions.set(session.id, session);
		try {
			return { status: "ok", sessionId: session.id, account: await this.account(session) };
		} catch (error) {
			void this.close(session.connectionId, session.id);
			throw error;
		}
	}

	/** Site, user, tokens and groups of a login. */
	async account(session: Session): Promise<NewApiAccount> {
		const [tokens, groups] = await Promise.all([this.tokens(session), this.groups(session)]);
		return {
			site: this.siteInfo(session.origin, session.status),
			user: session.user ?? { username: "用户" },
			tokens,
			groups,
		};
	}

	private async tokens(session: Session): Promise<NewApiToken[]> {
		const found = new Map<number, RawToken>();
		for (let page = 1; page <= TOKEN_MAX_PAGES; page++) {
			const data = await this.ok(session, "GET", `/api/token/?p=${page}&size=${TOKEN_PAGE_SIZE}`);
			const items = Array.isArray(data) ? data : isObject(data) && Array.isArray(data.items) ? data.items : [];
			for (const item of items) {
				const raw = isObject(item) ? toToken(item) : undefined;
				if (raw) found.set(raw.token.id, raw);
			}
			const total = isObject(data) ? num(data.total) : undefined;
			if (items.length < TOKEN_PAGE_SIZE || (total !== undefined && found.size >= total)) break;
		}
		session.keys.clear();
		for (const raw of found.values()) if (raw.key) session.keys.set(raw.token.id, raw.key);
		return [...found.values()].map((r) => r.token).sort((a, b) => b.id - a.id);
	}

	private async groups(session: Session): Promise<NewApiGroup[]> {
		let data: unknown;
		try {
			data = await this.ok(session, "GET", "/api/user/self/groups");
		} catch {
			data = await this.ok(session, "GET", "/api/user/groups").catch(() => undefined);
		}
		if (!isObject(data)) return [];
		return Object.entries(data)
			.map(([name, info]): NewApiGroup => {
				const record = isObject(info) ? info : {};
				const ratio = typeof record.ratio === "number" || typeof record.ratio === "string" ? record.ratio : undefined;
				return {
					name,
					...(str(record.desc) ? { description: str(record.desc) } : {}),
					...(ratio !== undefined ? { ratio } : {}),
				};
			})
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	async createToken(
		connectionId: string,
		sessionId: string,
		name: string,
		group?: string,
	): Promise<{ tokenId: number; tokens: NewApiToken[] }> {
		return this.createTokenIn(this.session(connectionId, sessionId), name, group);
	}

	/** Create an unlimited, never expiring token without model limits. */
	async createTokenIn(
		session: Session,
		name: string,
		group?: string,
	): Promise<{ tokenId: number; tokens: NewApiToken[] }> {
		const before = new Set((await this.tokens(session)).map((t) => t.id));
		await this.ok(session, "POST", "/api/token/", {
			name,
			remain_quota: 0,
			expired_time: -1,
			unlimited_quota: true,
			model_limits_enabled: false,
			model_limits: "",
			allow_ips: "",
			group: group ?? "",
		});
		const tokens = await this.tokens(session);
		const created = tokens.filter((t) => !before.has(t.id) && t.name === name).sort((a, b) => b.id - a.id)[0];
		if (!created) return fail("令牌已创建，但没有在列表中找到它，请刷新后选择");
		return { tokenId: created.id, tokens };
	}

	/** Read the full key of a token, hold it as a key reference, and list its models. */
	async useToken(
		connectionId: string,
		sessionId: string,
		tokenId: number,
	): Promise<{ keyRef: string; models: NewApiModel[]; modelsError?: string }> {
		return this.useTokenIn(this.session(connectionId, sessionId), connectionId, tokenId);
	}

	/** `useToken` for any login; the key reference belongs to `connectionId`. */
	async useTokenIn(
		session: Session,
		connectionId: string,
		tokenId: number,
	): Promise<{ keyRef: string; models: NewApiModel[]; modelsError?: string }> {
		let key: string | undefined;
		let problem: string | undefined;
		try {
			const envelope = await this.call(session, "POST", `/api/token/${tokenId}/key`);
			if (envelope.success === true && isObject(envelope.data) && str(envelope.data.key)) {
				key = fullKey(str(envelope.data.key) as string);
			} else problem = envelope.message;
		} catch (error) {
			if (error instanceof NewApiSessionExpired) throw error;
			problem = errorText(error);
		}
		if (!key) {
			// Older versions have no key endpoint but return full keys in the list.
			await this.tokens(session);
			key = session.keys.get(tokenId);
			if (!key) fail(problem?.startsWith("NewAPI") ? problem : `NewAPI：${problem || "读取令牌密钥失败"}`);
		}
		const ref = randomUUID();
		this.keyRefs.set(ref, { key: key as string, connectionId, expiresAt: this.now() + SESSION_TTL_MS });
		try {
			return { keyRef: ref, models: await this.models(session.origin, key as string) };
		} catch (error) {
			return { keyRef: ref, models: [], modelsError: errorText(error) };
		}
	}

	private async models(origin: string, key: string): Promise<NewApiModel[]> {
		let response: Response;
		try {
			response = await this.fetchImpl(`${origin}/v1/models`, {
				headers: { accept: "application/json", authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
		} catch (error) {
			return fail(`无法读取模型列表：${errorText(error)}`);
		}
		const text = await response.text().catch(() => "");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return fail(`读取模型列表失败（HTTP ${response.status}）`);
		}
		if (!response.ok) {
			const message = isObject(body) && isObject(body.error) ? str(body.error.message) : undefined;
			return fail(`读取模型列表失败（HTTP ${response.status}）${message ? `：${message.split(key).join("***")}` : ""}`);
		}
		const list = isObject(body) && Array.isArray(body.data) ? body.data : [];
		const models = new Map<string, NewApiModel>();
		for (const item of list) {
			const id = isObject(item) ? str(item.id) : str(item);
			if (!id || models.has(id)) continue;
			const api = detectNewApiModelApi(id, isObject(item) ? item.supported_endpoint_types : undefined);
			models.set(id, { id, ...(api ? { api } : {}) });
		}
		return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
	}

	/** The key behind a reference from `useToken`, for the connection that created it. */
	resolveKey(connectionId: string, ref: string): string {
		this.sweep();
		const entry = this.keyRefs.get(ref);
		if (!entry || entry.connectionId !== connectionId) {
			throw new PierProtocolError("NOT_FOUND", "NewAPI 令牌已过期，请重新选择令牌");
		}
		return entry.key;
	}

	// ---- sessions owned by the caller ---------------------------------------------------------

	/**
	 * Take over a finished login from `login` / `verify`: it no longer expires or belongs to a
	 * connection, and is not signed out when the connection closes.
	 */
	detach(connectionId: string, sessionId: string): NewApiSession {
		const session = this.session(connectionId, sessionId);
		if (session.verify) throw new PierProtocolError("CONFLICT", "登录还需要验证码");
		this.drop(sessionId);
		return session;
	}

	/** What to persist to resume `session` later. Short-lived dashboard tokens are left out. */
	save(session: NewApiSession): SavedNewApiSession {
		return {
			origin: session.origin,
			ownLogin: session.ownLogin,
			...(session.userId ? { userId: session.userId } : {}),
			...(session.user ? { user: session.user } : {}),
			...(session.bearer && !session.ownLogin ? { bearer: session.bearer } : {}),
			...(session.cookies.size ? { cookies: Object.fromEntries(session.cookies) } : {}),
		};
	}

	/** Resume a saved login. Dashboard logins get a new access token on first use. */
	restore(saved: SavedNewApiSession, status: Json = {}): NewApiSession {
		const cookies = new Map(Object.entries(saved.cookies ?? {}));
		return {
			id: randomUUID(),
			connectionId: "",
			origin: saved.origin,
			status,
			ownLogin: saved.ownLogin,
			...(saved.bearer ? { bearer: saved.bearer } : {}),
			...(saved.userId ? { userId: saved.userId } : {}),
			...(saved.user ? { user: saved.user } : {}),
			...(saved.ownLogin && cookies.has(REFRESH_COOKIE) ? { renew: {} } : {}),
			cookies,
			keys: new Map(),
			expiresAt: Number.POSITIVE_INFINITY,
		};
	}

	/** Call `onChange` whenever the login's tokens change (renewed or expired). */
	watch(session: NewApiSession, onChange: () => void): void {
		if (session.renew) session.renew.onChange = onChange;
	}

	/** The raw `/api/user/self` of a login (balance, group, email, ...). */
	async self(session: NewApiSession): Promise<Json> {
		const data = await this.ok(session, "GET", "/api/user/self");
		if (!isObject(data)) return fail("NewAPI 没有返回用户信息");
		this.setUser(session, data);
		return data;
	}

	/** Email a registration verification code. */
	async sendVerification(origin: string, email: string): Promise<void> {
		await this.ok(
			{ origin, cookies: new Map() },
			"GET",
			`/api/verification?${new URLSearchParams({ email, turnstile: "" })}`,
		);
	}

	/** Register a password account (sign in with `login` afterwards). */
	async register(
		origin: string,
		params: { username: string; password: string; email?: string; code?: string; affCode?: string },
	): Promise<void> {
		const envelope = await this.call(
			{ origin, cookies: new Map() },
			"POST",
			"/api/user/register",
			{
				username: params.username,
				password: params.password,
				...(params.email ? { email: params.email } : {}),
				...(params.code ? { verification_code: params.code } : {}),
				...(params.affCode ? { aff_code: params.affCode } : {}),
			},
			{ allowUnauthorized: true },
		);
		if (envelope.success !== true) fail(`NewAPI：${envelope.message || "注册失败"}`);
	}

	/** End a login taken over with `detach` / `restore`. */
	async signOut(session: NewApiSession): Promise<void> {
		session.renew = undefined;
		await this.revoke(session);
	}

	async close(connectionId: string, sessionId: string): Promise<boolean> {
		const session = this.sessions.get(sessionId);
		if (!session || session.connectionId !== connectionId) return false;
		this.drop(sessionId);
		await this.revoke(session);
		return true;
	}

	/** End the dashboard login we created (never the user's own access token). */
	private async revoke(session: Session): Promise<void> {
		try {
			if (session.ownLogin && (session.bearer || session.cookies.has(REFRESH_COOKIE))) {
				await this.call(session, "POST", "/api/user/auth/logout", undefined, { headers: { origin: session.origin } });
			} else if (!session.bearer && session.cookies.size) {
				await this.call(session, "GET", "/api/user/logout");
			}
		} catch (error) {
			this.options.log?.(`Signing out of ${session.origin} failed: ${errorText(error)}`);
		}
	}

	// ---- browser authorization ------------------------------------------------------------

	siteInfo(origin: string, status: Json): NewApiAccount["site"] {
		return {
			name: str(status.system_name) ?? new URL(origin).host,
			url: origin,
			...(str(status.version) ? { version: str(status.version) } : {}),
			...(str(status.logo) ? { logo: str(status.logo) } : {}),
		};
	}

	/** Start a browser authorization for a new API token (see `authorizeWait`). */
	authorizeStart(connectionId: string, baseUrl: string): Promise<NewApiAuthorizeStart> {
		return this.startFlow(connectionId, baseUrl, "token");
	}

	/**
	 * Start a browser sign-in to the account (see `authorizeSessionWait`). With `redirectUri` (a
	 * loopback address on the client's computer) the browser returns there instead, and the
	 * client hands the callback over with `authorizeSessionCallback`.
	 */
	authorizeSessionStart(connectionId: string, baseUrl: string, redirectUri?: string): Promise<NewApiAuthorizeStart> {
		return this.startFlow(connectionId, baseUrl, "account", redirectUri);
	}

	/** Listen on a loopback port (unless the client catches the redirect) and build the consent page URL. */
	private async startFlow(
		connectionId: string,
		baseUrl: string,
		scope: AuthorizeScope,
		clientRedirect?: string,
	): Promise<NewApiAuthorizeStart> {
		if (clientRedirect !== undefined && !isLoopbackRedirect(clientRedirect)) {
			fail("回调地址必须是 http://127.0.0.1:<端口>/callback");
		}
		this.sweep();
		const origin = normalizeNewApiUrl(baseUrl);
		const status = await this.siteStatus(origin);
		if (status.app_authorization_enabled !== true) {
			fail(
				"该站点没有开启浏览器授权（需要支持应用授权的 NewAPI，并由管理员在「系统设置 → 认证」中开启），请改用账号密码或访问令牌登录",
			);
		}
		if (scope === "account" && !supportsAccountScope(status)) {
			fail("该站点的 NewAPI 版本还不支持在浏览器中登录账号，请改用账号密码或访问令牌登录");
		}

		let server: Server | undefined;
		let redirectUri = clientRedirect;
		if (redirectUri === undefined) {
			const listening = createServer();
			await new Promise<void>((resolve, reject) => {
				listening.once("error", reject);
				listening.listen(0, "127.0.0.1", () => {
					listening.off("error", reject);
					resolve();
				});
			});
			const { port } = listening.address() as AddressInfo;
			server = listening;
			redirectUri = `http://127.0.0.1:${port}/callback`;
		}
		const verifier = randomBytes(32).toString("base64url");
		let resolve!: (result: NewApiAuthorizeResult | SessionLoginResult) => void;
		let reject!: (error: Error) => void;
		const result = new Promise<NewApiAuthorizeResult | SessionLoginResult>((res, rej) => {
			resolve = res;
			reject = rej;
		});
		// Settled flows may never be awaited (the dialog was closed).
		result.catch(() => undefined);
		const flow: AuthorizeFlow = {
			id: randomUUID(),
			scope,
			connectionId,
			origin,
			status,
			state: randomBytes(24).toString("base64url"),
			verifier,
			redirectUri,
			...(server ? { server } : {}),
			timer: setTimeout(
				() => this.endFlow(flow, new PierProtocolError("CONFLICT", "浏览器授权已超时，请重新授权")),
				AUTHORIZE_TTL_MS,
			),
			answered: false,
			ended: false,
			result,
			resolve,
			reject,
		};
		flow.timer.unref?.();
		server?.on("request", (req, res) => void this.serveCallback(flow, req, res));
		this.flows.set(flow.id, flow);

		const query = new URLSearchParams({
			client_name: AUTHORIZE_CLIENT_NAME,
			redirect_uri: flow.redirectUri,
			code_challenge: createHash("sha256").update(verifier).digest("base64url"),
			code_challenge_method: "S256",
			state: flow.state,
			...(scope === "account" ? { scope } : { key_name: `Pier · ${hostname()}`.slice(0, 40) }),
		});
		return {
			flowId: flow.id,
			authorizeUrl: `${origin}/app-auth?${query}`,
			site: this.siteInfo(origin, status),
			expiresAt: new Date(this.now() + AUTHORIZE_TTL_MS).toISOString(),
		};
	}

	/** A redirect that reached this host's own loopback port. */
	private async serveCallback(flow: AuthorizeFlow, req: IncomingMessage, res: ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", flow.redirectUri);
		if (req.method !== "GET" || url.pathname !== "/callback") {
			res.writeHead(404).end();
			return;
		}
		const page = await this.callback(flow, url.searchParams);
		callbackPage(res, page.status, page.title, page.detail);
	}

	/** Handle a redirect from the consent page, settling the flow; returns the page for the browser. */
	private async callback(flow: AuthorizeFlow, params: URLSearchParams): Promise<LoopbackCallbackPage> {
		const page = (status: number, title: string, detail: string): LoopbackCallbackPage => ({ status, title, detail });
		// Anything on the browser's computer can reach the port; only the right state may settle the flow.
		if (!sameSecret(params.get("state") ?? "", flow.state)) {
			return page(400, "无效的授权回调", "请回到 Pier 重新发起授权。");
		}
		if (flow.answered || flow.ended) {
			return page(409, "授权已经处理过了", "可以关闭此页面并回到 Pier。");
		}
		flow.answered = true;
		const code = params.get("code");
		if (!code) {
			const denied = params.get("error") === "access_denied";
			const message = denied ? "已在浏览器中取消授权" : `授权失败：${params.get("error") || "没有返回授权码"}`;
			this.endFlow(flow, new PierProtocolError("CONFLICT", message));
			return page(400, message, "可以关闭此页面并回到 Pier。");
		}
		try {
			if (flow.scope === "account") {
				const result = await this.exchangeSession(flow, code);
				const user = result.account.user;
				const name = user.displayName && user.displayName !== user.username ? user.displayName : user.username;
				this.endFlow(flow, result);
				return page(200, "登录成功", `Pier 已登录 ${name}，可以关闭此页面并回到 Pier。`);
			}
			const result = await this.exchange(flow, code);
			this.endFlow(flow, result);
			return page(200, "授权成功", `令牌「${result.token.name}」已交给 Pier，可以关闭此页面并回到 Pier。`);
		} catch (error) {
			const message = errorText(error);
			this.endFlow(flow, error instanceof Error ? error : new Error(message));
			return page(400, "授权失败", `${message}。请回到 Pier 重新授权。`);
		}
	}

	/**
	 * Hand over a redirect the client caught on its own computer for a sign-in started with a
	 * `redirectUri`; returns the page its browser should show.
	 */
	authorizeSessionCallback(connectionId: string, flowId: string, query: string): Promise<LoopbackCallbackPage> {
		const flow = this.flow(connectionId, flowId, "account");
		if (flow.server) fail("这次浏览器登录会回到本机，不需要转交回调");
		return this.callback(flow, new URLSearchParams(query));
	}

	private async exchange(flow: AuthorizeFlow, code: string): Promise<NewApiAuthorizeResult> {
		const data = await this.ok({ origin: flow.origin, cookies: new Map() }, "POST", "/api/app-auth/token", {
			code,
			code_verifier: flow.verifier,
			redirect_uri: flow.redirectUri,
		});
		const body = isObject(data) ? data : {};
		const rawKey = str(body.key);
		const rawToken = isObject(body.token) ? body.token : {};
		const tokenId = num(rawToken.id);
		if (!rawKey || !tokenId) return fail("NewAPI 没有返回令牌");
		const key = fullKey(rawKey);
		const rawUser = isObject(body.user) ? body.user : {};
		const userId = num(rawUser.id);
		const ref = randomUUID();
		this.keyRefs.set(ref, { key, connectionId: flow.connectionId, expiresAt: this.now() + SESSION_TTL_MS });
		let models: NewApiModel[] = [];
		let modelsError: string | undefined;
		try {
			models = await this.models(flow.origin, key);
		} catch (error) {
			modelsError = errorText(error);
		}
		return {
			site: this.siteInfo(flow.origin, flow.status),
			user: {
				...(userId ? { id: userId } : {}),
				username: str(rawUser.username) ?? (userId ? `#${userId}` : "用户"),
				...(str(rawUser.display_name) ? { displayName: str(rawUser.display_name) } : {}),
			},
			token: {
				id: tokenId,
				name: str(rawToken.name) ?? `#${tokenId}`,
				...(str(rawToken.group) ? { group: str(rawToken.group) } : {}),
				maskedKey: maskKey(key),
			},
			keyRef: ref,
			models,
			...(modelsError ? { modelsError } : {}),
		};
	}

	/** Exchange a sign-in code for a login session of Pier's own (like a password login). */
	private async exchangeSession(flow: AuthorizeFlow, code: string): Promise<SessionLoginResult> {
		const data = await this.ok({ origin: flow.origin, cookies: new Map() }, "POST", "/api/app-auth/token", {
			code,
			code_verifier: flow.verifier,
			redirect_uri: flow.redirectUri,
		});
		const body = isObject(data) ? data : {};
		const accessToken = str(body.access_token);
		const refreshToken = str(body.refresh_token);
		if (!accessToken || !refreshToken) return fail("NewAPI 没有返回登录凭据");
		const session: Session = {
			id: randomUUID(),
			connectionId: flow.connectionId,
			origin: flow.origin,
			status: flow.status,
			ownLogin: true,
			bearer: accessToken,
			cookies: new Map([[REFRESH_COOKIE, refreshToken]]),
			renew: { accessExpiresAt: epochMs(body.access_expires_at) },
			keys: new Map(),
			expiresAt: this.now() + SESSION_TTL_MS,
		};
		this.setUser(session, isObject(body.user) ? body.user : {});
		const result = await this.finish(session);
		if (result.status !== "ok") return fail("NewAPI 登录还需要验证");
		return result;
	}

	/** Settle a flow, stop listening and forget it. */
	private endFlow(flow: AuthorizeFlow, outcome: NewApiAuthorizeResult | SessionLoginResult | Error): void {
		if (flow.ended) return;
		flow.ended = true;
		clearTimeout(flow.timer);
		if (outcome instanceof Error) flow.reject(outcome);
		else flow.resolve(outcome);
		// Let the callback page finish before the port closes.
		flow.server?.close();
		flow.server?.closeIdleConnections?.();
		if (this.flows.get(flow.id) === flow) {
			// Keep the settled flow briefly so a late `authorizeWait` still gets the outcome.
			const forget = setTimeout(() => {
				if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id);
			}, 60_000);
			forget.unref?.();
		}
	}

	private flow(connectionId: string, flowId: string, scope: AuthorizeScope): AuthorizeFlow {
		const flow = this.flows.get(flowId);
		if (!flow || flow.connectionId !== connectionId || flow.scope !== scope) {
			throw new PierProtocolError("NOT_FOUND", "浏览器授权已结束，请重新授权");
		}
		return flow;
	}

	/** Wait until the user approves or declines in the browser. */
	async authorizeWait(connectionId: string, flowId: string): Promise<NewApiAuthorizeResult> {
		const flow = this.flow(connectionId, flowId, "token");
		try {
			return (await flow.result) as NewApiAuthorizeResult;
		} finally {
			this.flows.delete(flow.id);
		}
	}

	/**
	 * Wait until the user signs Pier in (or declines) in the browser. The login belongs to
	 * `connectionId` like one from `login`; take it over with `detach`.
	 */
	async authorizeSessionWait(connectionId: string, flowId: string): Promise<SessionLoginResult> {
		const flow = this.flow(connectionId, flowId, "account");
		try {
			return (await flow.result) as SessionLoginResult;
		} finally {
			this.flows.delete(flow.id);
		}
	}

	authorizeCancel(connectionId: string, flowId: string): boolean {
		const flow = this.flows.get(flowId);
		if (!flow || flow.connectionId !== connectionId) return false;
		this.flows.delete(flowId);
		this.endFlow(flow, new PierProtocolError("CONFLICT", "已取消浏览器授权"));
		return true;
	}

	connectionClosed(connectionId: string): void {
		for (const flow of [...this.flows.values()]) {
			if (flow.connectionId === connectionId) this.authorizeCancel(connectionId, flow.id);
		}
		for (const [id, session] of this.sessions) {
			if (session.connectionId !== connectionId) continue;
			this.drop(id);
			void this.revoke(session);
		}
		for (const [ref, entry] of this.keyRefs) if (entry.connectionId === connectionId) this.keyRefs.delete(ref);
	}

	shutdown(): void {
		for (const flow of [...this.flows.values()]) this.authorizeCancel(flow.connectionId, flow.id);
		for (const id of [...this.sessions.keys()]) {
			const session = this.drop(id);
			if (session) void this.revoke(session);
		}
		this.keyRefs.clear();
	}
}
