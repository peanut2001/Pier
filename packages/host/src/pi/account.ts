import { existsSync, readFileSync, rmSync } from "node:fs";
import {
	type AccountLoginResult,
	type AccountOverview,
	type AccountSite,
	type AccountStatus,
	type AccountUser,
	type NewApiLoginResult,
	PierProtocolError,
} from "@pier/protocol";
import { writePrivateFile } from "../config.ts";
import {
	type NewApiManager,
	type NewApiSession,
	NewApiSessionExpired,
	normalizeNewApiUrl,
	type SavedNewApiSession,
} from "./newapi.ts";

/**
 * The personal center: one login to the 云链API site that belongs to the host rather than to
 * a connection. The login is saved in the Pier directory (owner-only) so it survives restarts:
 * for password logins only the site's rotating refresh cookie, for access-token logins the
 * user's system access token. Token keys never leave the host; `useToken` hands out the same
 * key references as `newapi.useToken`.
 */

type Json = Record<string, unknown>;

/** Pseudo connection id that owns logins until they are taken over. */
const OWNER = "#account";
/** How long the site's public status is reused. */
const STATUS_TTL_MS = 60_000;

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const num = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface SavedAccount {
	version: 1;
	session: SavedNewApiSession;
}

/** Sign-in and account settings the site publishes in `/api/status`. */
export function accountSite(origin: string, status: Json): AccountSite {
	const oauth = [
		status.github_oauth === true && "GitHub",
		status.linuxdo_oauth === true && "LinuxDO",
		status.discord_oauth === true && "Discord",
		status.oidc_enabled === true && (str(status.oidc_display_name) ?? "OIDC"),
		status.telegram_oauth === true && "Telegram",
		status.wechat_login === true && "微信",
		status.passkey_login === true && "Passkey",
	].filter((m): m is string => Boolean(m));
	const type = str(status.quota_display_type) ?? (status.display_in_currency === false ? "TOKENS" : "USD");
	return {
		name: str(status.system_name) ?? new URL(origin).host,
		url: origin,
		...(str(status.version) ? { version: str(status.version) } : {}),
		...(str(status.logo) ? { logo: str(status.logo) } : {}),
		registerEnabled: status.register_enabled !== false && status.password_register_enabled !== false,
		emailVerification: status.email_verification === true,
		passwordLogin: status.password_login_enabled !== false,
		turnstile: status.turnstile_check === true,
		oauth,
		quota: {
			perUnit: num(status.quota_per_unit) || 500_000,
			type,
			...(num(status.usd_exchange_rate) ? { usdRate: num(status.usd_exchange_rate) } : {}),
			...(str(status.custom_currency_symbol) ? { customSymbol: str(status.custom_currency_symbol) } : {}),
			...(num(status.custom_currency_exchange_rate) ? { customRate: num(status.custom_currency_exchange_rate) } : {}),
		},
	};
}

export interface AccountManagerOptions {
	/** The site, e.g. `https://api.yunnet.top`. */
	site: string;
	/** Where the login is saved. */
	file: string;
	log?: (message: string) => void;
}

export class AccountManager {
	private readonly origin: string;
	private session: NewApiSession | undefined;
	private loaded = false;
	/** A password login waiting for its two-factor code. */
	private pending: string | undefined;
	private status: { at: number; value: Json } | undefined;

	constructor(
		private readonly newapi: NewApiManager,
		private readonly options: AccountManagerOptions,
	) {
		this.origin = normalizeNewApiUrl(options.site);
	}

	// ---- persistence ---------------------------------------------------------------------

	private current(): NewApiSession | undefined {
		if (!this.loaded) {
			this.loaded = true;
			try {
				if (existsSync(this.options.file)) {
					const saved = JSON.parse(readFileSync(this.options.file, "utf8")) as Partial<SavedAccount>;
					if (saved.version === 1 && saved.session?.origin === this.origin) {
						this.adopt(this.newapi.restore(saved.session));
					}
				}
			} catch (error) {
				this.options.log?.(`Could not read the saved 云链API login: ${errorText(error)}`);
			}
		}
		return this.session;
	}

	private adopt(session: NewApiSession): void {
		this.session = session;
		this.newapi.watch(session, () => {
			if (this.session === session) this.persist();
		});
	}

	private persist(): void {
		const session = this.session;
		if (!session) {
			rmSync(this.options.file, { force: true });
			return;
		}
		const saved: SavedAccount = { version: 1, session: this.newapi.save(session) };
		try {
			writePrivateFile(this.options.file, `${JSON.stringify(saved, null, 2)}\n`);
		} catch (error) {
			this.options.log?.(`Could not save the 云链API login: ${errorText(error)}`);
		}
	}

	private forget(): void {
		this.session = undefined;
		this.persist();
	}

	/** The signed-in login, or an error asking to sign in. Forgets logins the site rejects. */
	private async signedIn<T>(fn: (session: NewApiSession) => Promise<T>): Promise<T> {
		const session = this.current();
		if (!session) throw new PierProtocolError("CONFLICT", "请先登录云链API");
		try {
			return await fn(session);
		} catch (error) {
			if (error instanceof NewApiSessionExpired && this.session === session) {
				this.forget();
				throw new PierProtocolError("CONFLICT", "云链API 登录已过期，请重新登录");
			}
			throw error;
		}
	}

	// ---- site ----------------------------------------------------------------------------

	private async siteStatus(fresh = false): Promise<Json> {
		const cached = this.status;
		if (!fresh && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
		const value = await this.newapi.siteStatus(this.origin);
		this.status = { at: Date.now(), value };
		return value;
	}

	async getStatus(): Promise<AccountStatus> {
		const session = this.current();
		const user = session?.user;
		const signedIn = session ? { user: user ?? { username: "用户" } } : {};
		try {
			return { site: accountSite(this.origin, await this.siteStatus()), ...signedIn };
		} catch (error) {
			return { siteError: errorText(error), ...signedIn };
		}
	}

	// ---- sign-in -------------------------------------------------------------------------

	private dropPending(): void {
		if (this.pending) void this.newapi.close(OWNER, this.pending);
		this.pending = undefined;
	}

	private async finish(result: NewApiLoginResult): Promise<AccountLoginResult> {
		if (result.status === "verify") {
			this.pending = result.sessionId;
			return { status: "verify", methods: result.methods };
		}
		this.pending = undefined;
		const previous = this.session;
		this.adopt(this.newapi.detach(OWNER, result.sessionId));
		this.loaded = true;
		this.persist();
		if (previous) void this.newapi.signOut(previous);
		return { status: "ok", overview: await this.overview() };
	}

	async login(
		params: { username: string; password: string } | { accessToken: string; userId?: number | undefined },
	): Promise<AccountLoginResult> {
		this.dropPending();
		const site = accountSite(this.origin, await this.siteStatus(true));
		if ("password" in params && site.turnstile) {
			throw new PierProtocolError(
				"BAD_REQUEST",
				`${site.name} 开启了人机验证，无法在 Pier 中用密码登录，请改用「访问令牌」登录`,
			);
		}
		return this.finish(await this.newapi.login(OWNER, { baseUrl: this.origin, ...params }));
	}

	async verify(code: string): Promise<AccountLoginResult> {
		const pending = this.pending;
		if (!pending) throw new PierProtocolError("CONFLICT", "登录已过期，请重新输入账号密码");
		return this.finish(await this.newapi.verify(OWNER, pending, code));
	}

	async sendCode(email: string): Promise<{ sent: true }> {
		const site = accountSite(this.origin, await this.siteStatus());
		if (site.turnstile) throw new PierProtocolError("BAD_REQUEST", `${site.name} 开启了人机验证，请在网页上注册`);
		await this.newapi.sendVerification(this.origin, email);
		return { sent: true };
	}

	async register(params: {
		username: string;
		password: string;
		email?: string | undefined;
		code?: string | undefined;
		affCode?: string | undefined;
	}): Promise<AccountLoginResult> {
		const site = accountSite(this.origin, await this.siteStatus(true));
		if (!site.registerEnabled) throw new PierProtocolError("BAD_REQUEST", `${site.name} 目前没有开放注册`);
		if (site.turnstile) throw new PierProtocolError("BAD_REQUEST", `${site.name} 开启了人机验证，请在网页上注册`);
		if (site.emailVerification && (!params.email || !params.code)) {
			throw new PierProtocolError("BAD_REQUEST", "请填写邮箱并输入收到的验证码");
		}
		await this.newapi.register(this.origin, {
			username: params.username,
			password: params.password,
			...(params.email ? { email: params.email } : {}),
			...(params.code ? { code: params.code } : {}),
			...(params.affCode ? { affCode: params.affCode } : {}),
		});
		return this.login({ username: params.username, password: params.password });
	}

	async logout(): Promise<{ loggedOut: boolean }> {
		this.dropPending();
		const session = this.current();
		if (!session) return { loggedOut: false };
		this.forget();
		await this.newapi.signOut(session);
		return { loggedOut: true };
	}

	// ---- account -------------------------------------------------------------------------

	async overview(): Promise<AccountOverview> {
		return this.signedIn(async (session) => {
			const [status, self] = await Promise.all([this.siteStatus(), this.newapi.self(session)]);
			const account = await this.newapi.account(session);
			const user: AccountUser = {
				...account.user,
				...(str(self.email) ? { email: str(self.email) } : {}),
				quota: num(self.quota) ?? 0,
				usedQuota: num(self.used_quota) ?? 0,
				requestCount: num(self.request_count) ?? 0,
			};
			// Keep the saved name up to date for `getStatus`.
			this.persist();
			return { site: accountSite(this.origin, status), user, tokens: account.tokens, groups: account.groups };
		});
	}

	createToken(name: string, group?: string) {
		return this.signedIn((session) => this.newapi.createTokenIn(session, name, group));
	}

	useToken(connectionId: string, tokenId: number) {
		return this.signedIn((session) => this.newapi.useTokenIn(session, connectionId, tokenId));
	}

	shutdown(): void {
		this.dropPending();
	}
}
