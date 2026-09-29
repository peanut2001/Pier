import { constants, createCipheriv, publicEncrypt, randomBytes, randomUUID } from "node:crypto";
import {
	type NewApiAccount,
	type NewApiGroup,
	type NewApiLoginResult,
	type NewApiToken,
	PierProtocolError,
} from "@pier/protocol";

/**
 * Sign-in to NewAPI (https://github.com/QuantumNous/new-api) sites: log in with a password
 * (optionally with a two-factor code) or a system access token, list and create API tokens,
 * and read a token's key so it can be saved as a custom provider without the key ever
 * reaching the client.
 *
 * Supports both the current dashboard auth (login returns a Bearer access token) and the
 * older cookie session that needs a `New-Api-User` header.
 */

const REQUEST_TIMEOUT_MS = 15_000;
/** Login sessions and key references expire after this long without use. */
const SESSION_TTL_MS = 30 * 60_000;
const TOKEN_PAGE_SIZE = 100;
const TOKEN_MAX_PAGES = 10;

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

interface Session {
	id: string;
	connectionId: string;
	origin: string;
	status: Json;
	/** Dashboard access token (current versions) or the user's system access token. */
	bearer?: string;
	/** Whether `bearer` came from our own password login (and may be revoked on close). */
	ownLogin: boolean;
	userId?: number;
	cookies: Map<string, string>;
	/** Pending two-factor verification. */
	verify?: { kind: "flow"; flowToken: string } | { kind: "legacy" };
	user?: NewApiAccount["user"];
	keys: Map<number, string>;
	expiresAt: number;
}

interface KeyRef {
	key: string;
	connectionId: string;
	expiresAt: number;
}

export interface NewApiManagerOptions {
	log?: (message: string) => void;
	/** Override for tests. */
	fetch?: typeof fetch;
	now?: () => number;
}

export class NewApiManager {
	private readonly sessions = new Map<string, Session>();
	private readonly keyRefs = new Map<string, KeyRef>();
	private readonly fetchImpl: typeof fetch;
	private readonly now: () => number;

	constructor(private readonly options: NewApiManagerOptions = {}) {
		this.fetchImpl = options.fetch ?? fetch;
		this.now = options.now ?? Date.now;
	}

	// ---- HTTP ------------------------------------------------------------------------------

	private async call(
		session: Pick<Session, "origin" | "bearer" | "userId" | "cookies">,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
		options: { headers?: Record<string, string>; allowUnauthorized?: boolean } = {},
	): Promise<Envelope> {
		const url = `${session.origin}${path}`;
		const headers: Record<string, string> = {
			accept: "application/json",
			"accept-language": "zh-CN,zh;q=0.9,en;q=0.5",
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
			fail(`NewAPI 登录已失效，请重新登录${envelope.message ? `（${envelope.message}）` : ""}`);
		}
		if (!response.ok && envelope.success === undefined) fail(`${url} 返回 HTTP ${response.status}`);
		return { ...envelope, ...(response.ok ? {} : { success: false }) };
	}

	/** `call` that throws the site's message unless it reports success. */
	private async ok(
		session: Pick<Session, "origin" | "bearer" | "userId" | "cookies">,
		method: "GET" | "POST",
		path: string,
		body?: unknown,
	): Promise<unknown> {
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

	private async siteStatus(origin: string): Promise<Json> {
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

	private async account(session: Session): Promise<NewApiAccount> {
		const [tokens, groups] = await Promise.all([this.tokens(session), this.groups(session)]);
		const { status } = session;
		return {
			site: {
				name: str(status.system_name) ?? new URL(session.origin).host,
				url: session.origin,
				...(str(status.version) ? { version: str(status.version) } : {}),
				...(str(status.logo) ? { logo: str(status.logo) } : {}),
			},
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
		const session = this.session(connectionId, sessionId);
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
	): Promise<{ keyRef: string; models: Array<{ id: string; name?: string }>; modelsError?: string }> {
		const session = this.session(connectionId, sessionId);
		let key: string | undefined;
		let problem: string | undefined;
		try {
			const envelope = await this.call(session, "POST", `/api/token/${tokenId}/key`);
			if (envelope.success === true && isObject(envelope.data) && str(envelope.data.key)) {
				key = fullKey(str(envelope.data.key) as string);
			} else problem = envelope.message;
		} catch (error) {
			if (error instanceof PierProtocolError && error.message.includes("登录已失效")) throw error;
			problem = errorText(error);
		}
		if (!key) {
			// Older versions have no key endpoint but return full keys in the list.
			await this.tokens(session);
			key = session.keys.get(tokenId);
			if (!key) fail(`NewAPI：${problem || "读取令牌密钥失败"}`);
		}
		const ref = randomUUID();
		this.keyRefs.set(ref, { key: key as string, connectionId, expiresAt: this.now() + SESSION_TTL_MS });
		try {
			return { keyRef: ref, models: await this.models(session.origin, key as string) };
		} catch (error) {
			return { keyRef: ref, models: [], modelsError: errorText(error) };
		}
	}

	private async models(origin: string, key: string): Promise<Array<{ id: string; name?: string }>> {
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
		const ids = new Set<string>();
		for (const item of list) {
			const id = isObject(item) ? str(item.id) : str(item);
			if (id) ids.add(id);
		}
		return [...ids].sort((a, b) => a.localeCompare(b)).map((id) => ({ id }));
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
			if (session.ownLogin && session.bearer) {
				await this.call(session, "POST", "/api/user/auth/logout", undefined, { headers: { origin: session.origin } });
			} else if (!session.bearer && session.cookies.size) {
				await this.call(session, "GET", "/api/user/logout");
			}
		} catch (error) {
			this.options.log?.(`Signing out of ${session.origin} failed: ${errorText(error)}`);
		}
	}

	connectionClosed(connectionId: string): void {
		for (const [id, session] of this.sessions) {
			if (session.connectionId !== connectionId) continue;
			this.drop(id);
			void this.revoke(session);
		}
		for (const [ref, entry] of this.keyRefs) if (entry.connectionId === connectionId) this.keyRefs.delete(ref);
	}

	shutdown(): void {
		for (const id of [...this.sessions.keys()]) {
			const session = this.drop(id);
			if (session) void this.revoke(session);
		}
		this.keyRefs.clear();
	}
}
