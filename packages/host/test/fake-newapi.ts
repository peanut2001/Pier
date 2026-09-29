import { constants, createDecipheriv, createHash, generateKeyPairSync, privateDecrypt, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A small fake NewAPI site: the current dashboard auth (`modern`) or the older cookie session (`legacy`). */

export const PASSWORD = "correct horse battery staple";
export const TOKEN_KEY_A = "AAAAbbbbccccddddeeeeffffgggghhhh1111";
export const TOKEN_KEY_B = "BBBBbbbbccccddddeeeeffffgggghhhh2222";
export const DASHBOARD_TOKEN = "dashboard-access-token-xyz";
export const PAT = "personal-access-token-abc";
export const TOTP = "123456";

export interface FakeOptions {
	variant: "modern" | "legacy";
	twoFA?: boolean;
	encryption?: boolean;
	turnstile?: boolean;
	/** NewAPI app authorization (`/app-auth` + `POST /api/app-auth/token`). */
	appAuth?: boolean;
	/** App authorization also offers the `account` scope (sign-in instead of a token). */
	appAccount?: boolean;
	/** Registration needs an emailed verification code. */
	emailVerification?: boolean;
}

export const EMAIL_CODE = "654321";

/** What the site's consent page received, and the code it issued. */
export interface FakeGrant {
	code: string;
	/** The approved token; undefined for a sign-in (`scope=account`). */
	tokenId: number | undefined;
	params: URLSearchParams;
}

export interface FakeNewApi {
	url: string;
	server: Server;
	options: FakeOptions;
	logouts: number;
	requests: Array<{ method: string; path: string; headers: IncomingMessage["headers"] }>;
	tokens: Array<{ id: number; name: string; key: string; group: string; status: number }>;
	grants: FakeGrant[];
	/** Dashboard access tokens the site accepts (modern variant). */
	accessTokens: Set<string>;
	/** The refresh token of the dashboard login (rotated on every refresh). */
	refreshToken: string | undefined;
	refreshes: number;
	/** Password accounts, `alice` included. */
	users: Map<string, string>;
	/** Emails that were sent a verification code. */
	codesSent: string[];
	/** Access tokens handed out by sign-in grants. */
	appSessions: number;
	/**
	 * Play the browser: "sign in" on the consent page of `authorizeUrl`, approve a new token (or
	 * the sign-in, for `scope=account`) and return the loopback URL the site redirects to.
	 */
	approve(authorizeUrl: string): string;
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

export function decryptV2(value: string, keyId: string): string {
	const [version, wrapped, nonce, ciphertext] = value.split(".");
	if (version !== "v2" || !wrapped || !nonce || !ciphertext) throw new Error("bad format");
	const secret = privateDecrypt(
		{
			key: privateKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
			oaepLabel: Buffer.from("password-v2"),
		},
		Buffer.from(wrapped, "base64"),
	);
	const data = Buffer.from(ciphertext, "base64");
	const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(nonce, "base64"));
	decipher.setAAD(Buffer.from(`password-v2:${keyId}`));
	decipher.setAuthTag(data.subarray(data.length - 16));
	return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8");
}

const USER = { id: 7, username: "alice", display_name: "Alice", group: "default" };

export function startFakeNewApi(options: FakeOptions): Promise<FakeNewApi> {
	const fake: FakeNewApi = {
		url: "",
		server: undefined as unknown as Server,
		options,
		logouts: 0,
		requests: [],
		tokens: [
			{ id: 1, name: "old", key: TOKEN_KEY_A, group: "", status: 3 },
			{ id: 2, name: "main", key: TOKEN_KEY_B, group: "vip", status: 1 },
		],
		grants: [],
		accessTokens: new Set([DASHBOARD_TOKEN]),
		refreshToken: undefined,
		refreshes: 0,
		users: new Map([["alice", PASSWORD]]),
		codesSent: [],
		appSessions: 0,
		approve(authorizeUrl) {
			const url = new URL(authorizeUrl);
			if (url.pathname !== "/app-auth") throw new Error(`unexpected consent page ${url.pathname}`);
			const params = url.searchParams;
			let id: number | undefined;
			if (params.get("scope") !== "account") {
				id = Math.max(...fake.tokens.map((t) => t.id)) + 1;
				fake.tokens.push({
					id,
					name: params.get("key_name") ?? "app",
					key: `APP${id}keykeykeykeykeykeykeykeykeykey`,
					group: "",
					status: 1,
				});
			}
			const grant = { code: randomBytes(16).toString("hex"), tokenId: id, params };
			fake.grants.push(grant);
			const redirect = new URL(params.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", grant.code);
			redirect.searchParams.set("state", params.get("state") ?? "");
			return redirect.toString();
		},
	};
	const send = (res: ServerResponse, body: unknown, status = 200, headers: Record<string, string> = {}) => {
		res.writeHead(status, { "content-type": "application/json", ...headers });
		res.end(JSON.stringify(body));
	};
	const readBody = (req: IncomingMessage) =>
		new Promise<Record<string, unknown>>((resolve) => {
			let text = "";
			req.on("data", (chunk) => {
				text += chunk;
			});
			req.on("end", () => resolve(text ? JSON.parse(text) : {}));
		});
	const authed = (req: IncomingMessage): boolean => {
		const auth = req.headers.authorization;
		if (options.variant === "modern") {
			const bearer = auth?.replace(/^Bearer /, "") ?? "";
			return fake.accessTokens.has(bearer) || bearer === PAT;
		}
		const user = req.headers["new-api-user"] === "7";
		return user && (req.headers.cookie?.includes("session=S1") === true || auth === `Bearer ${PAT}`);
	};
	let refreshCount = 0;
	const issueRefresh = () => {
		fake.refreshToken = `sid1.secret${++refreshCount}`;
		return `new_api_refresh=${fake.refreshToken}; Path=/api/user/auth; Max-Age=2592000; HttpOnly; SameSite=Strict`;
	};
	const expiresAt = () => Math.floor(Date.now() / 1000) + 15 * 60;
	const loginOk = (res: ServerResponse) =>
		options.variant === "modern"
			? send(
					res,
					{
						success: true,
						message: "",
						data: { access_token: DASHBOARD_TOKEN, access_expires_at: expiresAt(), user: USER },
					},
					200,
					{ "set-cookie": issueRefresh() },
				)
			: send(res, { success: true, message: "", data: USER }, 200, { "set-cookie": "session=S1; Path=/; HttpOnly" });

	fake.server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const path = url.pathname;
		fake.requests.push({ method: req.method ?? "GET", path, headers: req.headers });
		const body = req.method === "POST" ? await readBody(req) : {};

		if (path === "/v1/models") {
			const key = req.headers.authorization?.replace(/^Bearer sk-/, "");
			const token = fake.tokens.find((t) => t.key === key);
			if (!token) return send(res, { error: { message: `invalid key ${req.headers.authorization}` } }, 401);
			const data = [{ id: "m-b" }, { id: "m-a" }, { id: `only-${token.name}` }];
			// Current versions list the endpoint types of each model; `m-b` is served by an Anthropic-only channel.
			const typed =
				options.variant === "modern"
					? data.map((m) => ({ ...m, supported_endpoint_types: m.id === "m-b" ? ["anthropic"] : ["openai"] }))
					: data;
			return send(res, { object: "list", data: typed });
		}
		if (path === "/api/status") {
			return send(res, {
				success: true,
				data: {
					system_name: "测试站",
					version: options.variant === "modern" ? "v1.3.19" : "v0.6.0",
					password_login_enabled: true,
					register_enabled: true,
					password_register_enabled: true,
					email_verification: options.emailVerification === true,
					github_oauth: true,
					quota_per_unit: 500000,
					quota_display_type: "CNY",
					usd_exchange_rate: 7,
					password_login_encryption_enabled: options.encryption === true,
					turnstile_check: options.turnstile === true,
					...(options.appAuth ? { app_authorization_enabled: true } : {}),
					...(options.appAuth && options.appAccount ? { app_authorization_scopes: ["token", "account"] } : {}),
				},
			});
		}
		if (path === "/api/app-auth/token" && req.method === "POST" && options.appAuth) {
			const index = fake.grants.findIndex((g) => g.code === body.code);
			const grant = fake.grants[index];
			if (!grant) return send(res, { success: false, message: "授权码无效或已过期，请重新授权" });
			fake.grants.splice(index, 1);
			const challenge = createHash("sha256").update(String(body.code_verifier)).digest("base64url");
			if (challenge !== grant.params.get("code_challenge") || body.redirect_uri !== grant.params.get("redirect_uri")) {
				return send(res, { success: false, message: "授权码无效或已过期，请重新授权" });
			}
			if (grant.tokenId === undefined) {
				const access = `app-access-${++fake.appSessions}`;
				fake.accessTokens.add(access);
				fake.refreshToken = `sid-app.secret${++refreshCount}`;
				return send(res, {
					success: true,
					data: {
						scope: "account",
						access_token: access,
						token_type: "Bearer",
						access_expires_at: expiresAt(),
						refresh_token: fake.refreshToken,
						session: { sid: "sid-app", login_method: "app" },
						user: USER,
					},
				});
			}
			const token = fake.tokens.find((t) => t.id === grant.tokenId);
			return send(res, {
				success: true,
				data: { key: token?.key, token: { id: token?.id, name: token?.name, group: token?.group }, user: USER },
			});
		}
		if (path === "/api/user/login/encryption-key") {
			return send(res, { success: true, data: { enabled: true, kid: "k1", public_key: PUBLIC_PEM } });
		}
		if (path === "/api/user/login" && req.method === "POST") {
			let password = body.password as string | undefined;
			if (options.encryption) {
				if (body.password !== undefined || body.encryption_key_id !== "k1") {
					return send(res, { success: false, message: "参数错误" });
				}
				password = decryptV2(body.password_encrypted as string, "k1");
			}
			if (typeof body.username !== "string" || fake.users.get(body.username) !== password) {
				return send(res, { success: false, message: "用户名或密码错误" });
			}
			if (options.twoFA) {
				return options.variant === "modern"
					? send(res, {
							success: true,
							data: {
								require_verification: true,
								flow_token: "flow-1",
								methods: [
									{ method: "2fa", available: true },
									{ method: "passkey", available: false },
								],
							},
						})
					: send(res, { success: true, message: "请输入两步验证码", data: { require_2fa: true } }, 200, {
							"set-cookie": "pending=P1; Path=/",
						});
			}
			return loginOk(res);
		}
		if (path === "/api/user/login/verify" && options.variant === "modern") {
			if (body.flow_token !== "flow-1" || body.method !== "2fa")
				return send(res, { success: false, message: "参数错误" });
			if (body.code !== TOTP) return send(res, { success: false, message: "验证码错误" });
			return loginOk(res);
		}
		if (path === "/api/user/login/2fa" && options.variant === "legacy") {
			if (!req.headers.cookie?.includes("pending=P1")) return send(res, { success: false, message: "会话已过期" });
			if (body.code !== TOTP) return send(res, { success: false, message: "验证码错误" });
			return loginOk(res);
		}
		if (path === "/api/user/auth/refresh" && req.method === "POST" && options.variant === "modern") {
			const cookie = /new_api_refresh=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
			if (req.headers.origin !== fake.url) {
				return send(
					res,
					{ success: false, code: "AUTH_ORIGIN_FORBIDDEN", message: "request origin is not allowed" },
					403,
				);
			}
			if (!cookie || cookie !== fake.refreshToken) {
				return send(res, { success: false, code: "AUTH_SESSION_REVOKED", message: "Unauthorized" }, 401);
			}
			fake.refreshes++;
			const access = `access-${fake.refreshes}`;
			fake.accessTokens.add(access);
			return send(
				res,
				{ success: true, data: { access_token: access, access_expires_at: expiresAt(), user: USER } },
				200,
				{
					"set-cookie": issueRefresh(),
				},
			);
		}
		if (path === "/api/verification") {
			const email = url.searchParams.get("email") ?? "";
			if (!email.includes("@")) return send(res, { success: false, message: "邮箱地址无效" });
			fake.codesSent.push(email);
			return send(res, { success: true, message: "" });
		}
		if (path === "/api/user/register" && req.method === "POST") {
			const username = String(body.username ?? "");
			if (fake.users.has(username)) return send(res, { success: false, message: "用户名已存在" });
			if (
				options.emailVerification &&
				(body.verification_code !== EMAIL_CODE || !fake.codesSent.includes(String(body.email)))
			) {
				return send(res, { success: false, message: "验证码错误或已过期" });
			}
			fake.users.set(username, String(body.password));
			return send(res, { success: true, message: "" });
		}
		if (path === "/api/user/auth/logout" || path === "/api/user/logout") {
			fake.logouts++;
			fake.refreshToken = undefined;
			return send(res, { success: true });
		}
		if (path.startsWith("/api/")) {
			if (!authed(req)) {
				return options.variant === "legacy" && !req.headers["new-api-user"]
					? send(res, { success: false, message: "无权进行此操作，未提供 New-Api-User" }, 401)
					: send(res, { success: false, message: "无权进行此操作，未登录" }, 401);
			}
			if (path === "/api/user/self") {
				return send(res, {
					success: true,
					data: { ...USER, email: "alice@example.com", quota: 3_500_000, used_quota: 1_000_000, request_count: 42 },
				});
			}
			if (path === "/api/user/self/groups") {
				if (options.variant === "legacy") return send(res, { success: false, message: "not found" }, 404);
				return send(res, {
					success: true,
					data: { default: { desc: "默认分组", ratio: 1 }, vip: { desc: "VIP", ratio: 0.5 } },
				});
			}
			if (path === "/api/user/groups")
				return send(res, { success: true, data: { default: { desc: "默认", ratio: 1 } } });
			if (path === "/api/token/" && req.method === "GET") {
				const items = fake.tokens.map((t) => ({
					id: t.id,
					name: t.name,
					key: options.variant === "modern" ? `${t.key.slice(0, 4)}**********${t.key.slice(-4)}` : t.key,
					status: t.status,
					group: t.group,
					expired_time: -1,
					unlimited_quota: true,
					remain_quota: 0,
					model_limits_enabled: false,
					model_limits: "",
				}));
				return send(res, {
					success: true,
					data: options.variant === "modern" ? { page: 1, page_size: 100, total: items.length, items } : items,
				});
			}
			if (path === "/api/token/" && req.method === "POST") {
				const id = Math.max(...fake.tokens.map((t) => t.id)) + 1;
				fake.tokens.push({
					id,
					name: body.name as string,
					key: `NEW${id}keykeykeykeykeykeykeykeykeykey`,
					group: (body.group as string) ?? "",
					status: 1,
				});
				return send(res, { success: true, message: "" });
			}
			const keyMatch = /^\/api\/token\/(\d+)\/key$/.exec(path);
			if (keyMatch && req.method === "POST") {
				if (options.variant === "legacy") {
					res.writeHead(404, { "content-type": "text/html" });
					return res.end("<html>not found</html>");
				}
				const token = fake.tokens.find((t) => t.id === Number(keyMatch[1]));
				return token
					? send(res, { success: true, data: { key: token.key } })
					: send(res, { success: false, message: "记录不存在" });
			}
		}
		send(res, { success: false, message: "not found" }, 404);
	});
	return new Promise((resolve) => {
		fake.server.listen(0, "127.0.0.1", () => {
			fake.url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
			resolve(fake);
		});
	});
}
