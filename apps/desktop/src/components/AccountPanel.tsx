import type {
	AccountLoginResult,
	AccountOverview,
	AccountSite,
	AccountStatus,
	AgentConfigResult,
	NewApiGroup,
	NewApiToken,
	ProviderInfo,
} from "@pier/protocol";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	CLAUDE_FAMILIES,
	claudeFamilyModel,
	claudeModels,
	claudeRelayChanges,
	claudeRelayState,
	codexModels,
	codexRelayChanges,
	codexRelayState,
	type RelayGroup,
	relayModels,
} from "../lib/agent-relay.ts";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { useAppState, useSettingsTarget, useStore } from "../lib/store.tsx";
import { findYunlianGroupProvider, formatQuota, relayProvider, YUNLIAN_NAME, yunlianGroupId } from "../lib/yunlian.ts";
import {
	IconAlert,
	IconCheck,
	IconChevronDown,
	IconExternal,
	IconKey,
	IconLoader,
	IconPlus,
	IconPower,
	IconRefresh,
	IconX,
} from "./Icons.tsx";
import { SettingRow, SettingsCard, SettingsGroup } from "./SettingsUi.tsx";

/** 个人中心: the 云链API account behind Pier — sign-in, registration, balance and per-group keys. */

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function ErrorBanner({ error }: { error?: string | undefined }) {
	if (!error) return null;
	return (
		<div className="banner error inline">
			<IconAlert size={15} />
			<span>{error}</span>
		</div>
	);
}

/** Run an async action with a busy flag and an error message. */
function useAction() {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const run = useCallback(async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await fn();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	}, []);
	return { busy, error, setError, run };
}

function SiteHeader({ site }: { site: AccountSite }) {
	return (
		<div className="account-hero">
			{site.logo ? <img src={site.logo} alt="" className="account-logo" /> : <div className="account-logo" />}
			<div className="provider-main">
				<div className="account-hero-title">{site.name}</div>
				<div className="muted small">
					Pier 的模型服务由{site.name}提供。登录后可以查看余额，并把各分组的令牌一键配置为本地服务商。
				</div>
			</div>
		</div>
	);
}

// ---- sign-in and registration -----------------------------------------------------------

/** How long to wait for the user in the browser (the host abandons the flow after 10 minutes). */
const BROWSER_LOGIN_TIMEOUT_MS = 11 * 60_000;

/**
 * Sign in on the website in the system browser: every sign-in method of the site works there
 * (password, GitHub, LinuxDO, passkeys, human verification), and Pier never sees the password.
 */
function BrowserLogin({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const store = useStore();
	const [flow, setFlow] = useState<{ flowId: string; authorizeUrl: string } | undefined>();
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState<string | undefined>();
	// Bumped to abandon the current attempt (cancel, retry or leaving the page).
	const attempt = useRef(0);
	const pending = useRef<string | undefined>(undefined);

	const cancel = useCallback(() => {
		attempt.current++;
		const flowId = pending.current;
		pending.current = undefined;
		if (flowId) void store.account("account.authorizeCancel", { flowId }).catch(() => undefined);
		setFlow(undefined);
		setStarting(false);
	}, [store]);

	useEffect(() => cancel, [cancel]);

	const start = async () => {
		cancel();
		const current = ++attempt.current;
		setError(undefined);
		setStarting(true);
		try {
			const started = await store.account("account.authorizeStart", {});
			if (current !== attempt.current) {
				void store.account("account.authorizeCancel", { flowId: started.flowId }).catch(() => undefined);
				return;
			}
			pending.current = started.flowId;
			setFlow(started);
			setStarting(false);
			store.openExternal(started.authorizeUrl);
			const result = await store.account("account.authorizeWait", { flowId: started.flowId }, BROWSER_LOGIN_TIMEOUT_MS);
			if (current !== attempt.current) return;
			pending.current = undefined;
			setFlow(undefined);
			onDone(result);
		} catch (e) {
			if (current !== attempt.current) return;
			pending.current = undefined;
			setFlow(undefined);
			setStarting(false);
			setError(errorText(e));
		}
	};

	if (flow) {
		return (
			<div className="account-form">
				<p className="account-waiting">
					<IconLoader size={14} className="spin" />
					<span>已在浏览器中打开{site.name}，请在网页上登录，并在授权页面点击「授权」。完成后会自动回到这里。</span>
				</p>
				<div className="account-actions">
					<div className="account-links muted small">
						<button type="button" className="link-button" onClick={() => store.openExternal(flow.authorizeUrl)}>
							<IconExternal size={12} /> 浏览器没有打开？重新打开
						</button>
					</div>
					<button type="button" onClick={cancel}>
						取消
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="account-form">
			<p className="muted">
				在浏览器中登录{site.name}
				{site.oauth.length ? `（支持账号密码、${site.oauth.join("、")} 等所有登录方式）` : ""}
				，并允许 Pier 访问你的账户。没有账号可以在登录页面注册。
			</p>
			<ErrorBanner error={error} />
			<div className="account-actions">
				<span />
				<button type="button" className="primary" disabled={starting} onClick={() => void start()}>
					{starting ? <IconLoader size={14} className="spin" /> : <IconExternal size={14} />}
					在浏览器中登录
				</button>
			</div>
			<p className="muted small">Pier 不会接触你的密码，只保存一个可以随时在网页「登录会话」中注销的登录状态。</p>
		</div>
	);
}

function LoginForm({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const store = useStore();
	const [mode, setMode] = useState<"password" | "token">(site.passwordLogin && !site.turnstile ? "password" : "token");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [accessToken, setAccessToken] = useState("");
	const [userId, setUserId] = useState("");
	const [verifying, setVerifying] = useState(false);
	const [code, setCode] = useState("");
	const { busy, error, setError, run } = useAction();

	const finish = (result: AccountLoginResult) => {
		if (result.status === "verify") {
			setVerifying(true);
			setCode("");
			return;
		}
		setPassword("");
		onDone(result);
	};

	const submit = (e: FormEvent) => {
		e.preventDefault();
		void run(async () => {
			if (verifying) {
				if (!code.trim()) throw new Error("请输入验证码");
				finish(await store.account("account.verify", { code: code.trim() }));
			} else if (mode === "password") {
				if (!username.trim() || !password) throw new Error("请填写用户名和密码");
				finish(await store.account("account.login", { username: username.trim(), password }));
			} else {
				if (!accessToken.trim()) throw new Error("请填写系统访问令牌");
				const id = Number(userId.trim());
				if (userId.trim() && !(Number.isInteger(id) && id > 0)) throw new Error("用户 ID 必须是正整数");
				finish(
					await store.account("account.login", {
						accessToken: accessToken.trim(),
						...(userId.trim() ? { userId: id } : {}),
					}),
				);
			}
		});
	};

	if (verifying) {
		return (
			<form className="account-form" onSubmit={submit}>
				<p className="muted">该账号开启了两步验证，请输入身份验证器中的 6 位验证码（也可以使用备用码）。</p>
				<label className="form-field">
					<span className="field-label">验证码</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: the only field of this step.
						autoFocus
						inputMode="numeric"
						autoComplete="one-time-code"
						placeholder="123456"
						value={code}
						onChange={(e) => setCode(e.target.value)}
					/>
				</label>
				<ErrorBanner error={error} />
				<div className="account-actions">
					<button type="button" onClick={() => setVerifying(false)}>
						返回
					</button>
					<button type="submit" className="primary" disabled={busy || !code.trim()}>
						{busy ? <IconLoader size={14} className="spin" /> : null}
						验证
					</button>
				</div>
			</form>
		);
	}

	return (
		<form className="account-form" onSubmit={submit}>
			{mode === "password" ? (
				<div className="form-grid">
					<label className="form-field">
						<span className="field-label">用户名或邮箱</span>
						<input
							// biome-ignore lint/a11y/noAutofocus: first field of the form.
							autoFocus
							autoComplete="username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
						/>
					</label>
					<label className="form-field">
						<span className="field-label">密码</span>
						<input
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</label>
				</div>
			) : (
				<>
					<div className="form-grid">
						<label className="form-field">
							<span className="field-label">系统访问令牌</span>
							<input
								type="password"
								autoComplete="off"
								spellCheck={false}
								value={accessToken}
								onChange={(e) => setAccessToken(e.target.value)}
							/>
						</label>
						<label className="form-field">
							<span className="field-label">用户 ID（可选）</span>
							<input
								inputMode="numeric"
								placeholder="可选"
								value={userId}
								onChange={(e) => setUserId(e.target.value.replace(/\D/g, ""))}
							/>
						</label>
					</div>
					<p className="muted small">
						用 {site.oauth.length ? site.oauth.join("、") : "第三方账号"} 登录的账号没有密码：请在网页控制台「个人设置 →
						安全设置」中生成系统访问令牌，粘贴到这里。
						<button type="button" className="link-button" onClick={() => store.openExternal(`${site.url}/profile`)}>
							<IconExternal size={12} /> 打开个人设置
						</button>
					</p>
				</>
			)}
			<ErrorBanner error={error} />
			<div className="account-actions">
				<div className="account-links muted small">
					{site.passwordLogin && !site.turnstile ? (
						<button
							type="button"
							className="link-button"
							onClick={() => {
								setMode(mode === "password" ? "token" : "password");
								setError(undefined);
							}}
						>
							{mode === "password"
								? `${site.oauth.length ? `${site.oauth.join(" / ")} 账号？` : ""}使用访问令牌登录`
								: "使用账号密码登录"}
						</button>
					) : null}
					{mode === "password" ? (
						<button type="button" className="link-button" onClick={() => store.openExternal(`${site.url}/reset`)}>
							忘记密码
						</button>
					) : null}
				</div>
				<button type="submit" className="primary" disabled={busy}>
					{busy ? <IconLoader size={14} className="spin" /> : mode === "token" ? <IconKey size={14} /> : null}
					登录
				</button>
			</div>
			{mode === "password" ? <p className="muted small">密码只用于这次登录，不会被保存。</p> : null}
		</form>
	);
}

const CODE_COOLDOWN_S = 60;

function RegisterForm({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const store = useStore();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [affCode, setAffCode] = useState("");
	const [cooldown, setCooldown] = useState(0);
	const [sent, setSent] = useState(false);
	const { busy, error, setError, run } = useAction();
	const sending = useAction();

	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = setTimeout(() => setCooldown((n) => n - 1), 1000);
		return () => clearTimeout(timer);
	}, [cooldown]);

	if (!site.registerEnabled || site.turnstile) {
		return (
			<div className="account-form">
				<p className="muted">
					{site.registerEnabled
						? `${site.name} 注册需要人机验证，请在网页上完成注册，然后回到这里登录。`
						: `${site.name} 目前没有开放账号密码注册${site.oauth.length ? `，可以在网页上用 ${site.oauth.join("、")} 登录` : ""}。`}
				</p>
				<div className="account-actions">
					<span />
					<button type="button" onClick={() => store.openExternal(`${site.url}/register`)}>
						<IconExternal size={14} />
						在网页上注册
					</button>
				</div>
			</div>
		);
	}

	const sendCode = () =>
		void sending.run(async () => {
			if (!/^\S+@\S+\.\S+$/.test(email.trim())) throw new Error("请填写有效的邮箱地址");
			await store.account("account.sendCode", { email: email.trim() });
			setSent(true);
			setCooldown(CODE_COOLDOWN_S);
		});

	const submit = (e: FormEvent) => {
		e.preventDefault();
		void run(async () => {
			const name = username.trim();
			if (!name) throw new Error("请填写用户名");
			if ([...name].length > 20) throw new Error("用户名最多 20 个字符");
			if (password.length < 8) throw new Error("密码至少 8 位");
			if (password !== confirm) throw new Error("两次输入的密码不一致");
			if (site.emailVerification && (!email.trim() || !code.trim())) throw new Error("请填写邮箱并输入收到的验证码");
			const result = await store.account("account.register", {
				username: name,
				password,
				...(email.trim() ? { email: email.trim() } : {}),
				...(code.trim() ? { code: code.trim() } : {}),
				...(affCode.trim() ? { affCode: affCode.trim() } : {}),
			});
			setPassword("");
			setConfirm("");
			onDone(result);
		});
	};

	return (
		<form className="account-form" onSubmit={submit}>
			<div className="form-grid">
				<label className="form-field">
					<span className="field-label">用户名</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: first field of the form.
						autoFocus
						autoComplete="username"
						maxLength={20}
						placeholder="最多 20 个字符"
						value={username}
						onChange={(e) => setUsername(e.target.value)}
					/>
				</label>
				<label className="form-field">
					<span className="field-label">邀请码（可选）</span>
					<input value={affCode} maxLength={32} onChange={(e) => setAffCode(e.target.value)} />
				</label>
				<label className="form-field">
					<span className="field-label">密码</span>
					<input
						type="password"
						autoComplete="new-password"
						placeholder="至少 8 位"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
					/>
				</label>
				<label className="form-field">
					<span className="field-label">确认密码</span>
					<input
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(e) => setConfirm(e.target.value)}
					/>
				</label>
				{site.emailVerification ? (
					<>
						<div className="form-field">
							<span className="field-label">邮箱</span>
							<div className="auth-input-row">
								<input
									type="email"
									autoComplete="email"
									maxLength={50}
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
								<button type="button" disabled={sending.busy || cooldown > 0} onClick={sendCode}>
									{sending.busy ? <IconLoader size={13} className="spin" /> : null}
									{cooldown > 0 ? `${cooldown} 秒` : sent ? "重新发送" : "发送验证码"}
								</button>
							</div>
						</div>
						<label className="form-field">
							<span className="field-label">邮箱验证码</span>
							<input
								inputMode="numeric"
								autoComplete="one-time-code"
								value={code}
								onChange={(e) => setCode(e.target.value)}
							/>
						</label>
					</>
				) : null}
			</div>
			{sent && !sending.error ? <p className="muted small">验证码已发送到 {email.trim()}，请查收邮件。</p> : null}
			<ErrorBanner error={sending.error ?? error} />
			<div className="account-actions">
				<span />
				<button
					type="submit"
					className="primary"
					disabled={busy}
					onClick={() => {
						sending.setError(undefined);
						setError(undefined);
					}}
				>
					{busy ? <IconLoader size={14} className="spin" /> : null}
					注册并登录
				</button>
			</div>
		</form>
	);
}

function SignIn({ site, onDone }: { site: AccountSite; onDone: (result: AccountLoginResult) => void }) {
	const [tab, setTab] = useState<"login" | "register">("login");
	const target = useSettingsTarget();
	// The browser returns to a loopback address on the host's own computer, so a paired
	// computer signs in with a password or an access token instead.
	if (site.browserLogin && target.local) {
		return (
			<SettingsGroup>
				<SettingsCard className="account-card">
					<SiteHeader site={site} />
					<BrowserLogin site={site} onDone={onDone} />
				</SettingsCard>
			</SettingsGroup>
		);
	}
	// Sites without browser sign-in: enter the password or a system access token in Pier.
	return (
		<SettingsGroup>
			<SettingsCard className="account-card">
				<SiteHeader site={site} />
				{site.browserLogin ? (
					<p className="muted small">
						浏览器授权只能在 {target.name} 本机上完成。这里请用账号密码或访问令牌登录，登录状态保存在 {target.name} 上的
						Pier 中。
					</p>
				) : null}
				<div className="segmented" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "login"}
						className={tab === "login" ? "active" : ""}
						onClick={() => setTab("login")}
					>
						登录
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "register"}
						className={tab === "register" ? "active" : ""}
						onClick={() => setTab("register")}
					>
						注册
					</button>
				</div>
				{tab === "login" ? <LoginForm site={site} onDone={onDone} /> : <RegisterForm site={site} onDone={onDone} />}
			</SettingsCard>
		</SettingsGroup>
	);
}

// ---- signed in --------------------------------------------------------------------------

interface GroupEntry extends NewApiGroup {
	tokens: NewApiToken[];
	/** Not among the groups the account may use any more. */
	unavailable?: boolean;
}

/** Tokens sorted into the account's groups; tokens without a group use the user's own group. */
function groupEntries(overview: AccountOverview): GroupEntry[] {
	const own = overview.user.group || "default";
	const entries = new Map<string, GroupEntry>(overview.groups.map((g) => [g.name, { ...g, tokens: [] }]));
	for (const token of overview.tokens) {
		const name = token.group || own;
		let entry = entries.get(name);
		if (!entry) {
			entry = { name, tokens: [], unavailable: true };
			entries.set(name, entry);
		}
		entry.tokens.push(token);
	}
	const rank = (e: GroupEntry) => (e.name === own ? 0 : e.unavailable ? 2 : 1);
	return [...entries.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** A token name within NewAPI's 50-byte limit. */
function tokenName(group: string): string {
	const encoder = new TextEncoder();
	let name = `Pier · ${group}`;
	while (encoder.encode(name).length > 50) name = name.slice(0, -1);
	return name;
}

function ratioText(ratio: NewApiGroup["ratio"]): string | undefined {
	if (ratio === undefined) return undefined;
	return typeof ratio === "number" ? `${Number(ratio.toFixed(4))} 倍率` : String(ratio);
}

/** Claude Code's and Codex's user configuration on the managed computer, when it could be read. */
interface AgentConfigs {
	claude?: AgentConfigResult | undefined;
	codex?: AgentConfigResult | undefined;
}

/** Pointing Claude Code and Codex at a group needs protocol 1.25 (key references in `agentConfig.update`). */
const AGENT_RELAY_MINOR = 25;

/** Read both user files, again whenever Pier changes one of them. */
function useAgentConfigs(enabled: boolean): AgentConfigs | undefined {
	const store = useStore();
	const version = useAppState((s) => s.agentConfigVersion);
	const node = useAppState((s) => s.settingsNode);
	const [configs, setConfigs] = useState<AgentConfigs | undefined>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: reread when a file changes or the computer does.
	useEffect(() => {
		if (!enabled) {
			setConfigs(undefined);
			return;
		}
		let live = true;
		void Promise.all([
			store.getAgentConfig("claude-code").catch(() => undefined),
			store.getAgentConfig("codex").catch(() => undefined),
		]).then(([claude, codex]) => {
			if (live) setConfigs({ claude, codex });
		});
		return () => {
			live = false;
		};
	}, [store, enabled, version, node]);
	return configs;
}

function userSettings(config: AgentConfigResult | undefined) {
	return config?.files.find((f) => f.scope === "user")?.settings;
}

function userPath(config: AgentConfigResult | undefined, fallback: string): string {
	return config?.files.find((f) => f.scope === "user")?.path ?? fallback;
}

type TakeToken = () => Promise<{ keyRef: string }>;

function NotInstalled({ config }: { config: AgentConfigResult | undefined }) {
	return config && !config.available ? <span className="mini-tag">未安装</span> : null;
}

/** Write a group's endpoint, token and models into Claude Code's user settings. */
function ClaudeRelayRow({
	group,
	config,
	takeToken,
}: {
	group: RelayGroup;
	config: AgentConfigResult | undefined;
	takeToken: TakeToken;
}) {
	const store = useStore();
	const models = claudeModels(group);
	const state = claudeRelayState(userSettings(config), group);
	const [model, setModel] = useState(state.group && state.model && models.includes(state.model) ? state.model : "");
	const { busy, error, run } = useAction();
	const aliases = CLAUDE_FAMILIES.flatMap((family) => {
		const id = claudeFamilyModel(models, family);
		return id ? [`${family} → ${id}`] : [];
	});
	const path = userPath(config, "~/.claude/settings.json");

	const write = () =>
		void run(async () => {
			const { keyRef } = await takeToken();
			await store.updateAgentUserConfig("claude-code", claudeRelayChanges(group, keyRef, model || undefined));
			store.toast("info", `已把 Claude Code 接入${group.name}，新建的会话生效`);
		});

	return (
		<>
			<div className="provider-row account-agent-row">
				<div className="provider-main">
					<div className="provider-name">
						Claude Code
						{state.group ? (
							<span className="mini-tag ok">
								<IconCheck size={11} />
								正在使用
							</span>
						) : null}
						<NotInstalled config={config} />
					</div>
					<div className="muted small">
						{models.length
							? `写入 ${path} 的 API 地址与令牌${aliases.length ? `，别名 ${aliases.join("、")}` : ""}；会移除其中的 ANTHROPIC_API_KEY 与 apiKeyHelper。`
							: "这个分组没有通过 Anthropic 接口提供的模型，Claude Code 无法使用。"}
					</div>
				</div>
				<div className="row-actions">
					<select
						className="setting-select compact account-token-select"
						value={model}
						disabled={busy || !models.length}
						title="默认模型"
						onChange={(e) => setModel(e.target.value)}
					>
						<option value="">默认模型：按别名</option>
						{models.map((id) => (
							<option key={id} value={id}>
								{id}
							</option>
						))}
					</select>
					<button
						type="button"
						className={state.group ? "" : "primary"}
						disabled={busy || !models.length}
						onClick={write}
					>
						{busy ? <IconLoader size={13} className="spin" /> : null}
						{state.group ? "更新" : "接入"}
					</button>
				</div>
			</div>
			{error ? (
				<div className="account-group-error">
					<ErrorBanner error={error} />
				</div>
			) : null}
		</>
	);
}

/** Add the group as a Codex provider with the token and make it Codex's current one. */
function CodexRelayRow({
	group,
	config,
	takeToken,
}: {
	group: RelayGroup;
	config: AgentConfigResult | undefined;
	takeToken: TakeToken;
}) {
	const store = useStore();
	const models = codexModels(group);
	const state = codexRelayState(userSettings(config), group);
	const initial =
		(state.current && state.model && models.some((m) => m.id === state.model) ? state.model : undefined) ??
		models[0]?.id ??
		"";
	const [model, setModel] = useState(initial);
	const { busy, error, run } = useAction();
	const chosen = models.find((m) => m.id === model) ?? models[0];
	const path = userPath(config, "~/.codex/config.toml");

	const write = () =>
		void run(async () => {
			if (!chosen) return;
			const { keyRef } = await takeToken();
			await store.updateAgentUserConfig("codex", codexRelayChanges(group, keyRef, chosen.id));
			store.toast("info", `已把 Codex 接入${group.name}（${chosen.id}），新建的会话生效`);
		});

	return (
		<>
			<div className="provider-row account-agent-row">
				<div className="provider-main">
					<div className="provider-name">
						Codex
						{state.current ? (
							<span className="mini-tag ok">
								<IconCheck size={11} />
								正在使用
							</span>
						) : null}
						<NotInstalled config={config} />
					</div>
					<div className="muted small">
						{chosen && !chosen.suited
							? "Codex 用 Responses API 调用模型，这个模型的渠道需要支持它（OpenAI 类模型最合适）。"
							: `在 ${path} 中添加服务商 ${group.id}（Responses API）并设为当前，同时设置默认模型。`}
					</div>
				</div>
				<div className="row-actions">
					<select
						className="setting-select compact account-token-select"
						value={chosen?.id ?? ""}
						disabled={busy || !models.length}
						title="默认模型"
						onChange={(e) => setModel(e.target.value)}
					>
						{models.map((m) => (
							<option key={m.id} value={m.id}>
								{m.id}
							</option>
						))}
					</select>
					<button type="button" className={state.current ? "" : "primary"} disabled={busy || !chosen} onClick={write}>
						{busy ? <IconLoader size={13} className="spin" /> : null}
						{state.current ? "更新" : "接入"}
					</button>
				</div>
			</div>
			{error ? (
				<div className="account-group-error">
					<ErrorBanner error={error} />
				</div>
			) : null}
		</>
	);
}

function GroupRow({
	entry,
	overview,
	provider,
	agents,
	onTokens,
	onRemove,
}: {
	entry: GroupEntry;
	overview: AccountOverview;
	/** The local provider configured for this group, if any. */
	provider?: ProviderInfo | undefined;
	/** Claude Code's and Codex's configuration, when the host can point them at the group. */
	agents?: AgentConfigs | undefined;
	onTokens: (tokens: NewApiToken[]) => void;
	/** Drop a group that was picked but not configured yet. */
	onRemove?: (() => void) | undefined;
}) {
	const store = useStore();
	const usable = entry.tokens.filter((t) => t.status === 1);
	const [choice, setChoice] = useState<number | "new">(usable[0]?.id ?? "new");
	const [agentsOpen, setAgentsOpen] = useState(false);
	const { busy, error, run } = useAction();
	const selected = choice === "new" || usable.some((t) => t.id === choice) ? choice : (usable[0]?.id ?? "new");
	const ratio = ratioText(entry.ratio);
	const relay: RelayGroup | undefined = provider?.custom
		? { id: provider.id, name: provider.name, siteUrl: overview.site.url, models: relayModels(provider.custom) }
		: undefined;
	const claudeInUse = relay && agents ? claudeRelayState(userSettings(agents.claude), relay).group : false;
	const codexInUse = relay && agents ? codexRelayState(userSettings(agents.codex), relay).current : false;

	/** A key reference for the chosen token, creating the token first when asked to. */
	const takeToken = async () => {
		let tokenId: number;
		if (selected === "new") {
			const created = await store.account("account.createToken", { name: tokenName(entry.name), group: entry.name });
			onTokens(created.tokens);
			tokenId = created.tokenId;
			setChoice(tokenId);
		} else tokenId = selected;
		return store.account("account.useToken", { tokenId });
	};

	const configure = () =>
		void run(async () => {
			const used = await takeToken();
			const target = {
				id: yunlianGroupId(entry.name),
				name: `${overview.site.name} · ${entry.name}`,
				siteUrl: overview.site.url,
			};
			const next = relayProvider(target, used.models, provider?.custom, used.modelsError);
			await store.saveCustomProvider(next, { apiKeyRef: used.keyRef }, !provider?.custom);
		});

	return (
		<div className="account-group">
			<div className="provider-row">
				<div className="provider-main">
					<div className="provider-name">
						{entry.name}
						{ratio ? <span className="mini-tag">{ratio}</span> : null}
						{entry.name === (overview.user.group || "default") ? <span className="mini-tag">我的分组</span> : null}
						{provider ? (
							<span className="mini-tag ok">
								<IconCheck size={11} />
								已配置
							</span>
						) : null}
						{claudeInUse ? <span className="mini-tag accent">Claude Code</span> : null}
						{codexInUse ? <span className="mini-tag accent">Codex</span> : null}
					</div>
					<div className="muted small">
						{[
							entry.unavailable ? "当前账号不可用的分组" : entry.description,
							provider
								? `本地服务商「${provider.name}」· ${provider.availableCount || provider.modelCount} 个模型`
								: `${usable.length} 个可用令牌`,
						]
							.filter(Boolean)
							.join(" · ")}
					</div>
				</div>
				<div className="row-actions">
					<select
						className="setting-select compact account-token-select"
						value={selected}
						disabled={busy}
						onChange={(e) => setChoice(e.target.value === "new" ? "new" : Number(e.target.value))}
					>
						{usable.map((token) => (
							<option key={token.id} value={token.id}>
								{token.name} · {token.maskedKey || `#${token.id}`}
							</option>
						))}
						<option value="new">新建令牌</option>
					</select>
					<button type="button" className={provider ? "" : "primary"} disabled={busy} onClick={configure}>
						{busy ? <IconLoader size={13} className="spin" /> : null}
						{provider ? "更新本地配置" : "配置到本地"}
					</button>
					{relay && agents ? (
						<button
							type="button"
							className={agentsOpen ? "account-agents-toggle open" : "account-agents-toggle"}
							title="把这个分组的令牌写入 Claude Code / Codex 的配置"
							aria-expanded={agentsOpen}
							onClick={() => setAgentsOpen((v) => !v)}
						>
							Claude Code / Codex
							<IconChevronDown size={12} className="account-agents-chevron" />
						</button>
					) : null}
					{!provider && onRemove ? (
						<button type="button" className="ghost icon" title="不添加这个分组" disabled={busy} onClick={onRemove}>
							<IconX size={13} />
						</button>
					) : null}
				</div>
			</div>
			{error ? (
				<div className="account-group-error">
					<ErrorBanner error={error} />
				</div>
			) : null}
			{relay && agents && agentsOpen ? (
				<div className="account-agents">
					<ClaudeRelayRow group={relay} config={agents.claude} takeToken={takeToken} />
					<CodexRelayRow group={relay} config={agents.codex} takeToken={takeToken} />
					<p className="muted small">
						使用上方选择的令牌，密钥由 Pier Host 直接写入配置文件（与终端中的 claude / codex 共用）。之后可以在「Agent
						配置」中查看和修改。
					</p>
				</div>
			) : null}
		</div>
	);
}

function Dashboard({
	overview,
	loading,
	onRefresh,
	onTokens,
	onLogout,
}: {
	overview: AccountOverview;
	loading: boolean;
	onRefresh: () => void;
	onTokens: (tokens: NewApiToken[]) => void;
	onLogout: () => Promise<void>;
}) {
	const store = useStore();
	const providers = useAppState((s) => s.providers);
	const target = useSettingsTarget();
	const [confirm, setConfirm] = useState(false);
	const agents = useAgentConfigs(!target.hostInfo || hostSpeaksMinor(target.hostInfo, AGENT_RELAY_MINOR));
	const { site, user } = overview;
	const entries = useMemo(() => groupEntries(overview), [overview]);
	const byId = new Map(providers?.providers.map((p) => [p.id, p]));
	// Only groups already configured locally are listed; others are added one at a time.
	const [picked, setPicked] = useState<string[]>([]);
	const [picking, setPicking] = useState(false);
	const groupNames = entries.map((e) => e.name);
	const providerOf = (entry: GroupEntry) => findYunlianGroupProvider(byId, entry.name, groupNames, site.name);
	const isConfigured = (entry: GroupEntry) => providerOf(entry) !== undefined;
	const shown = entries.filter((e) => isConfigured(e) || picked.includes(e.name));
	const addable = entries.filter((e) => !e.unavailable && !isConfigured(e) && !picked.includes(e.name));
	const [pick, setPick] = useState("");
	const pickValue = addable.some((e) => e.name === pick) ? pick : (addable[0]?.name ?? "");
	const addPicked = () => {
		if (!pickValue) return;
		setPicked((list) => [...list, pickValue]);
		setPicking(false);
	};
	const quota = (value: number) => formatQuota(value, site.quota);
	const name = user.displayName && user.displayName !== user.username ? user.displayName : user.username;

	return (
		<>
			<SettingsGroup
				title="账户"
				actions={
					<button type="button" className="ghost" disabled={loading} onClick={onRefresh}>
						{loading ? <IconLoader size={13} className="spin" /> : <IconRefresh size={13} />}
						刷新
					</button>
				}
			>
				<SettingsCard>
					<SettingRow
						title={
							<span className="account-user">
								<span className="account-avatar">{[...name][0]?.toUpperCase()}</span>
								<span>
									{name}
									{name !== user.username ? <span className="muted"> （{user.username}）</span> : null}
								</span>
							</span>
						}
						description={[
							user.email,
							user.group ? `分组 ${user.group}` : "",
							user.id ? `ID ${user.id}` : "",
							`${site.name}（${new URL(site.url).host}）`,
						]
							.filter(Boolean)
							.join(" · ")}
					>
						<button type="button" onClick={() => store.openExternal(`${site.url}/dashboard`)}>
							<IconExternal size={13} />
							网页控制台
						</button>
						<button
							type="button"
							className={confirm ? "danger" : "ghost"}
							onBlur={() => setConfirm(false)}
							onClick={() => {
								if (!confirm) {
									setConfirm(true);
									return;
								}
								void onLogout();
							}}
						>
							<IconPower size={13} />
							{confirm ? "确认退出" : "退出登录"}
						</button>
					</SettingRow>
				</SettingsCard>
				<div className="account-stats">
					<div className="account-stat primary">
						<div className="muted small">当前余额</div>
						<div className="account-stat-value">{quota(user.quota)}</div>
						<button type="button" className="primary" onClick={() => store.openExternal(`${site.url}/wallet`)}>
							<IconExternal size={13} />
							充值
						</button>
					</div>
					<div className="account-stat">
						<div className="muted small">历史消耗</div>
						<div className="account-stat-value">{quota(user.usedQuota)}</div>
					</div>
					<div className="account-stat">
						<div className="muted small">请求次数</div>
						<div className="account-stat-value">{user.requestCount.toLocaleString("zh-CN")}</div>
					</div>
				</div>
			</SettingsGroup>
			<SettingsGroup
				title={`分组与令牌（${shown.length}）`}
				actions={
					<>
						<button
							type="button"
							className="ghost"
							disabled={!addable.length}
							title={addable.length ? undefined : "所有可用分组都已添加"}
							onClick={() => setPicking((v) => !v)}
						>
							<IconPlus size={13} />
							添加分组
						</button>
						<button type="button" className="ghost" onClick={() => store.openExternal(`${site.url}/keys`)}>
							<IconExternal size={13} />
							管理令牌
						</button>
					</>
				}
			>
				<p className="muted small settings-note">
					这里只列出已配置到本地的分组。点「添加分组」选择要使用的分组，再选择它的令牌（或新建令牌）后点「配置到本地」，Pier
					会读取这个令牌可用的全部模型，添加为服务商「{site.name} · 分组名」，可以在「模型与服务商」中查看和编辑。
					{agents ? "配置后点「Claude Code / Codex」，可以把同一个分组接入 Claude Code 与 Codex。" : null}
				</p>
				<div className="provider-list">
					{picking && addable.length ? (
						<div className="account-group">
							<div className="provider-row">
								<div className="provider-main">
									<div className="provider-name">添加分组</div>
									<div className="muted small">选择一个分组加入列表，然后为它配置令牌。</div>
								</div>
								<div className="row-actions">
									<select
										className="setting-select compact account-token-select"
										value={pickValue}
										onChange={(e) => setPick(e.target.value)}
									>
										{addable.map((entry) => (
											<option key={entry.name} value={entry.name}>
												{[entry.name, ratioText(entry.ratio), entry.description].filter(Boolean).join(" · ")}
											</option>
										))}
									</select>
									<button type="button" className="primary" disabled={!pickValue} onClick={addPicked}>
										添加
									</button>
									<button type="button" className="ghost" onClick={() => setPicking(false)}>
										取消
									</button>
								</div>
							</div>
						</div>
					) : null}
					{shown.map((entry) => (
						<GroupRow
							key={entry.name}
							entry={entry}
							overview={overview}
							provider={providerOf(entry)}
							agents={agents}
							onTokens={onTokens}
							onRemove={() => setPicked((list) => list.filter((name) => name !== entry.name))}
						/>
					))}
					{!shown.length && !picking ? (
						<div className="provider-row muted small">
							{entries.length
								? "还没有配置到本地的分组，点右上角「添加分组」选择要使用的分组。"
								: "这个账号还没有可用的分组。"}
						</div>
					) : null}
				</div>
				<p className="muted small settings-note">
					令牌密钥由 Pier Host 直接保存在{target.local ? "本机" : ` ${target.name} 上`}，不会显示在界面上。
				</p>
			</SettingsGroup>
		</>
	);
}

// ---- page ------------------------------------------------------------------------------

/** The “个人中心” settings page. */
export function AccountSettings() {
	const store = useStore();
	const [status, setStatus] = useState<AccountStatus | undefined>();
	const [overview, setOverview] = useState<AccountOverview | undefined>();
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | undefined>();

	const load = useCallback(async () => {
		setLoading(true);
		setError(undefined);
		try {
			const next = await store.account("account.status", {});
			setStatus(next);
			if (!next.user) {
				setOverview(undefined);
				return;
			}
			try {
				setOverview(await store.account("account.overview", {}));
			} catch (e) {
				setError(errorText(e));
				// The login may have expired: show the sign-in form again.
				const again = await store.account("account.status", {}).catch(() => next);
				setStatus(again);
				if (!again.user) setOverview(undefined);
			}
		} catch (e) {
			setError(errorText(e));
		} finally {
			setLoading(false);
		}
	}, [store]);

	useEffect(() => {
		void load();
	}, [load]);

	const signedIn = (result: AccountLoginResult) => {
		if (result.status !== "ok") return;
		setError(undefined);
		setOverview(result.overview);
		setStatus((s) => ({ ...s, site: result.overview.site, user: result.overview.user }));
		store.toast("info", `已登录 ${result.overview.site.name}：${result.overview.user.username}`);
	};

	const logout = async () => {
		try {
			await store.account("account.logout", {});
			setOverview(undefined);
			setStatus((s) => (s?.site ? { site: s.site } : s));
			store.toast("info", `已退出 ${status?.site?.name ?? YUNLIAN_NAME}`);
		} catch (e) {
			setError(errorText(e));
		}
	};

	if (!status) {
		return loading ? (
			<p className="muted account-loading">
				<IconLoader size={14} className="spin" /> 正在连接{YUNLIAN_NAME}…
			</p>
		) : (
			<LoadError error={error} onRetry={() => void load()} />
		);
	}

	if (status.user && overview) {
		return (
			<>
				<ErrorBanner error={error} />
				<Dashboard
					overview={overview}
					loading={loading}
					onRefresh={() => void load()}
					onTokens={(tokens) => setOverview((o) => (o ? { ...o, tokens } : o))}
					onLogout={logout}
				/>
			</>
		);
	}
	if (status.user) {
		return loading ? (
			<p className="muted account-loading">
				<IconLoader size={14} className="spin" /> 正在读取账户信息…
			</p>
		) : (
			<LoadError error={error} onRetry={() => void load()} onLogout={() => void logout()} />
		);
	}
	if (!status.site) return <LoadError error={status.siteError ?? error} onRetry={() => void load()} />;
	return (
		<>
			<ErrorBanner error={error} />
			<SignIn site={status.site} onDone={signedIn} />
		</>
	);
}

function LoadError({
	error,
	onRetry,
	onLogout,
}: {
	error?: string | undefined;
	onRetry: () => void;
	onLogout?: () => void;
}) {
	return (
		<SettingsCard>
			<SettingRow title={`无法连接${YUNLIAN_NAME}`} description={error ?? "请检查网络后重试。"}>
				{onLogout ? (
					<button type="button" className="ghost" onClick={onLogout}>
						退出登录
					</button>
				) : null}
				<button type="button" onClick={onRetry}>
					<IconRefresh size={13} />
					重试
				</button>
			</SettingRow>
		</SettingsCard>
	);
}
