import type {
	CustomProviderApi,
	NewApiAccount,
	NewApiAuthorizeStart,
	NewApiLoginResult,
	NewApiToken,
} from "@pier/protocol";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store.tsx";
import { IconAlert, IconCheck, IconCopy, IconExternal, IconKey, IconLoader, IconPlus } from "./Icons.tsx";

/** What the NewAPI sign-in hands to the custom endpoint form. */
export interface NewApiPreset {
	name: string;
	id: string;
	/** Site address without a path suffix, e.g. `https://api.example.com`. */
	siteUrl: string;
	api: CustomProviderApi;
	models: Array<{ id: string; name?: string }>;
	modelsError?: string;
	/** Host-side reference to the token key. */
	keyRef: string;
	/** Human readable token, e.g. `Pier（sk-abcd**********wxyz）`. */
	keyLabel: string;
}

/** Base URL of a NewAPI site for a wire API. */
export function newApiBaseUrl(siteUrl: string, api: CustomProviderApi): string {
	switch (api) {
		case "anthropic-messages":
			return siteUrl;
		case "google-generative-ai":
			return `${siteUrl}/v1beta`;
		default:
			return `${siteUrl}/v1`;
	}
}

const STATUS_LABEL: Record<number, string> = { 2: "已禁用", 3: "已过期", 4: "额度用尽" };

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function providerIdFor(url: string, taken: (id: string) => boolean): string {
	let base = "newapi";
	try {
		base =
			new URL(url).host
				.toLowerCase()
				.replace(/:\d+$/, "")
				.replace(/[^a-z0-9._-]+/g, "-")
				.replace(/^[-._]+|[-._]+$/g, "")
				.slice(0, 56) || base;
	} catch {
		// keep the fallback
	}
	if (!taken(base)) return base;
	for (let i = 2; i < 100; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
	return `${base}-${Date.now().toString(36)}`;
}

function tokenDetail(token: NewApiToken): string {
	const parts = [token.maskedKey || `#${token.id}`];
	parts.push(token.group ? `分组 ${token.group}` : "默认分组");
	if (token.modelLimits?.length) parts.push(`限 ${token.modelLimits.length} 个模型`);
	if (token.expiresAt) parts.push(`${new Date(token.expiresAt * 1000).toLocaleDateString()} 到期`);
	return parts.join(" · ");
}

type Step = "login" | "verify" | "token";
type Mode = "browser" | "password" | "token";

/** The last site address, so signing in to the same site again needs no typing. */
const LAST_SITE_KEY = "pier.newapi.lastSite";

function lastSite(): string {
	try {
		return localStorage.getItem(LAST_SITE_KEY) ?? "";
	} catch {
		return "";
	}
}

function rememberSite(url: string): void {
	try {
		localStorage.setItem(LAST_SITE_KEY, url);
	} catch {
		// storage unavailable
	}
}

export function NewApiConnect({
	takenIds,
	onReady,
}: {
	/** Provider ids already in use. */
	takenIds: ReadonlySet<string>;
	onReady: (preset: NewApiPreset) => void;
}) {
	const store = useStore();
	const [step, setStep] = useState<Step>("login");
	const [mode, setMode] = useState<Mode>("browser");
	const [baseUrl, setBaseUrl] = useState(lastSite);
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [accessToken, setAccessToken] = useState("");
	const [userId, setUserId] = useState("");
	const [code, setCode] = useState("");
	const [account, setAccount] = useState<NewApiAccount | undefined>();
	const [selected, setSelected] = useState<number | "new" | undefined>();
	const [newName, setNewName] = useState("Pier");
	const [newGroup, setNewGroup] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [authorizing, setAuthorizing] = useState<NewApiAuthorizeStart | undefined>();
	const [copied, setCopied] = useState(false);
	const sessionRef = useRef<string | undefined>(undefined);
	const flowRef = useRef<string | undefined>(undefined);

	// Forget the host-side login (or abandon the browser sign-in) when the dialog closes.
	useEffect(
		() => () => {
			if (sessionRef.current) store.newApiClose(sessionRef.current);
			if (flowRef.current) store.newApiAuthorizeCancel(flowRef.current);
		},
		[store],
	);

	const run = async (fn: () => Promise<void>) => {
		setBusy(true);
		setError(undefined);
		try {
			await fn();
		} catch (e) {
			setError(errorText(e));
		} finally {
			setBusy(false);
		}
	};

	const accept = (result: NewApiLoginResult) => {
		if (sessionRef.current && sessionRef.current !== result.sessionId) store.newApiClose(sessionRef.current);
		sessionRef.current = result.sessionId;
		if (result.status === "verify") {
			setCode("");
			setStep("verify");
			return;
		}
		rememberSite(result.account.site.url);
		setAccount(result.account);
		const usable = result.account.tokens.filter((t) => t.status === 1);
		setSelected(usable[0]?.id ?? "new");
		setStep("token");
	};

	const authorize = () =>
		run(async () => {
			const started = await store.newApiAuthorizeStart(baseUrl.trim());
			rememberSite(started.site.url);
			flowRef.current = started.flowId;
			setCopied(false);
			setAuthorizing(started);
			store.openExternal(started.authorizeUrl);
			try {
				const result = await store.newApiAuthorizeWait(started.flowId);
				onReady({
					name: result.site.name,
					id: providerIdFor(result.site.url, (id) => takenIds.has(id)),
					siteUrl: result.site.url,
					api: "openai-completions",
					models: result.models,
					...(result.modelsError ? { modelsError: result.modelsError } : {}),
					keyRef: result.keyRef,
					keyLabel: `${result.token.name}（${result.token.maskedKey}）`,
				});
			} catch (e) {
				// Cancelling from this dialog is not an error worth showing.
				if (flowRef.current === started.flowId) throw e;
			} finally {
				if (flowRef.current === started.flowId) flowRef.current = undefined;
				setAuthorizing(undefined);
			}
		});

	const cancelAuthorize = () => {
		const flowId = flowRef.current;
		flowRef.current = undefined;
		if (flowId) store.newApiAuthorizeCancel(flowId);
		setAuthorizing(undefined);
	};

	const login = (e: FormEvent) => {
		e.preventDefault();
		if (!baseUrl.trim()) {
			setError("请填写 NewAPI 站点地址");
			return;
		}
		if (mode === "browser") {
			void authorize();
			return;
		}
		void run(async () => {
			if (mode === "password") {
				if (!username.trim() || !password) throw new Error("请填写用户名和密码");
				accept(await store.newApiLogin({ baseUrl: baseUrl.trim(), username: username.trim(), password }));
			} else {
				if (!accessToken.trim()) throw new Error("请填写系统访问令牌");
				const id = Number(userId.trim());
				if (userId.trim() && !(Number.isInteger(id) && id > 0)) throw new Error("用户 ID 必须是正整数");
				accept(
					await store.newApiLogin({
						baseUrl: baseUrl.trim(),
						accessToken: accessToken.trim(),
						...(userId.trim() ? { userId: id } : {}),
					}),
				);
			}
			setPassword("");
		});
	};

	const verify = (e: FormEvent) => {
		e.preventDefault();
		const sessionId = sessionRef.current;
		if (!sessionId || !code.trim()) return;
		void run(async () => accept(await store.newApiVerify(sessionId, code.trim())));
	};

	const next = () => {
		const sessionId = sessionRef.current;
		if (!sessionId || !account || selected === undefined) return;
		void run(async () => {
			let tokenId: number;
			let tokens = account.tokens;
			if (selected === "new") {
				if (!newName.trim()) throw new Error("请填写令牌名称");
				const created = await store.newApiCreateToken(sessionId, newName.trim(), newGroup || undefined);
				tokenId = created.tokenId;
				tokens = created.tokens;
				setAccount({ ...account, tokens });
				setSelected(tokenId);
			} else tokenId = selected;
			const token = tokens.find((t) => t.id === tokenId);
			const used = await store.newApiUseToken(sessionId, tokenId);
			onReady({
				name: account.site.name,
				id: providerIdFor(account.site.url, (id) => takenIds.has(id)),
				siteUrl: account.site.url,
				api: "openai-completions",
				models: used.models,
				...(used.modelsError ? { modelsError: used.modelsError } : {}),
				keyRef: used.keyRef,
				keyLabel: token ? `${token.name}（${token.maskedKey || `#${token.id}`}）` : `令牌 #${tokenId}`,
			});
		});
	};

	const errorBanner = error ? (
		<div className="banner error inline">
			<IconAlert size={15} />
			<span>{error}</span>
		</div>
	) : null;

	if (authorizing) {
		const { site } = authorizing;
		return (
			<div className="newapi-form">
				<div className="newapi-account">
					{site.logo ? <img src={site.logo} alt="" className="newapi-logo" /> : null}
					<div className="provider-main">
						<div className="provider-name">
							{site.name}
							{site.version ? <span className="mini-tag">{site.version}</span> : null}
						</div>
						<div className="muted small mono">{site.url}</div>
					</div>
				</div>
				<p className="muted">
					已在浏览器中打开授权页面。请在浏览器里登录（账号密码、GitHub、LinuxDO、Passkey
					等该站点支持的方式都可以），确认令牌设置后点击「授权」，完成后会自动回到这里。
				</p>
				<div className="newapi-waiting">
					<IconLoader size={15} className="spin" />
					<span>等待浏览器中完成授权…</span>
				</div>
				<p className="muted small">
					浏览器没有打开？
					<button type="button" className="link-button" onClick={() => store.openExternal(authorizing.authorizeUrl)}>
						<IconExternal size={12} /> 重新打开
					</button>
					或
					<button
						type="button"
						className="link-button"
						onClick={() => {
							void navigator.clipboard
								.writeText(authorizing.authorizeUrl)
								.then(() => setCopied(true))
								.catch(() => undefined);
						}}
					>
						<IconCopy size={12} /> {copied ? "已复制" : "复制链接"}
					</button>
					到本机的浏览器中打开。
				</p>
				<div className="modal-actions">
					<button type="button" onClick={cancelAuthorize}>
						取消
					</button>
				</div>
			</div>
		);
	}

	if (step === "verify") {
		return (
			<form className="newapi-form" onSubmit={verify}>
				<p className="muted">该账号开启了两步验证，请输入身份验证器中的 6 位验证码（也可以使用备用码）。</p>
				<div className="auth-input-row">
					<input
						// biome-ignore lint/a11y/noAutofocus: the only field of this step.
						autoFocus
						inputMode="numeric"
						autoComplete="one-time-code"
						placeholder="123456"
						value={code}
						onChange={(e) => setCode(e.target.value)}
					/>
					<button type="submit" className="primary" disabled={busy || !code.trim()}>
						{busy ? <IconLoader size={14} className="spin" /> : null}
						验证
					</button>
				</div>
				{errorBanner}
				<div className="modal-actions">
					<button type="button" onClick={() => setStep("login")}>
						返回
					</button>
				</div>
			</form>
		);
	}

	if (step === "token" && account) {
		const { site, user } = account;
		return (
			<div className="newapi-form">
				<div className="newapi-account">
					{site.logo ? <img src={site.logo} alt="" className="newapi-logo" /> : null}
					<div className="provider-main">
						<div className="provider-name">
							{site.name}
							{site.version ? <span className="mini-tag">{site.version}</span> : null}
						</div>
						<div className="muted small">
							{user.displayName && user.displayName !== user.username
								? `${user.displayName}（${user.username}）`
								: user.username}
							{user.group ? ` · 分组 ${user.group}` : ""} · <span className="mono">{site.url}</span>
						</div>
					</div>
				</div>
				<div className="field-label">选择要在 Pier 中使用的令牌</div>
				<div className="provider-list newapi-tokens">
					{account.tokens.map((token) => {
						const disabled = token.status !== 1;
						return (
							<label key={token.id} className={`provider-row option-row${disabled ? " disabled" : ""}`}>
								<input
									type="radio"
									name="newapi-token"
									disabled={disabled}
									checked={selected === token.id}
									onChange={() => setSelected(token.id)}
								/>
								<span className="provider-main">
									<span className="provider-name">
										{token.name}
										{disabled ? <span className="mini-tag">{STATUS_LABEL[token.status] ?? "不可用"}</span> : null}
									</span>
									<span className="muted small mono">{tokenDetail(token)}</span>
								</span>
							</label>
						);
					})}
					<label className="provider-row option-row">
						<input type="radio" name="newapi-token" checked={selected === "new"} onChange={() => setSelected("new")} />
						<span className="provider-main">
							<span className="provider-name">
								<IconPlus size={13} />
								新建令牌
							</span>
							<span className="muted small">无限额度、永不过期、不限模型，可以之后在 NewAPI 控制台修改</span>
						</span>
					</label>
				</div>
				{selected === "new" ? (
					<div className="form-grid newapi-new-token">
						<label className="form-field">
							<span className="field-label">令牌名称</span>
							<input value={newName} maxLength={50} onChange={(e) => setNewName(e.target.value)} />
						</label>
						<label className="form-field">
							<span className="field-label">分组</span>
							<select value={newGroup} onChange={(e) => setNewGroup(e.target.value)}>
								<option value="">默认分组{user.group ? `（${user.group}）` : ""}</option>
								{account.groups.map((group) => (
									<option key={group.name} value={group.name}>
										{group.name}
										{group.description && group.description !== group.name ? ` · ${group.description}` : ""}
										{group.ratio !== undefined ? ` · 倍率 ${group.ratio}` : ""}
									</option>
								))}
							</select>
						</label>
					</div>
				) : null}
				<p className="muted small">令牌密钥由 Pier Host 直接读取并保存在本机，不会显示在界面上。</p>
				{errorBanner}
				<div className="modal-actions">
					<button
						type="button"
						onClick={() => {
							setStep("login");
							setError(undefined);
						}}
					>
						换个账号
					</button>
					<button type="button" className="primary" disabled={busy || selected === undefined} onClick={next}>
						{busy ? <IconLoader size={14} className="spin" /> : <IconCheck size={14} />}
						{selected === "new" ? "创建并获取模型" : "获取模型"}
					</button>
				</div>
			</div>
		);
	}

	return (
		<form className="newapi-form" onSubmit={login}>
			<p className="muted">
				登录 NewAPI（One API 衍生的中转站面板），Pier 会获取令牌和可用模型，自动添加为自定义接口。
			</p>
			<label className="form-field">
				<span className="field-label">站点地址</span>
				<input
					// biome-ignore lint/a11y/noAutofocus: first field of the dialog.
					autoFocus
					className="mono"
					placeholder="https://api.example.com"
					value={baseUrl}
					spellCheck={false}
					onChange={(e) => setBaseUrl(e.target.value)}
				/>
			</label>
			<div className="segmented" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={mode === "browser"}
					className={mode === "browser" ? "active" : ""}
					onClick={() => setMode("browser")}
				>
					<IconExternal size={13} />
					浏览器授权
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === "password"}
					className={mode === "password" ? "active" : ""}
					onClick={() => setMode("password")}
				>
					账号密码
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={mode === "token"}
					className={mode === "token" ? "active" : ""}
					onClick={() => setMode("token")}
				>
					<IconKey size={13} />
					访问令牌
				</button>
			</div>
			{mode === "browser" ? (
				<p className="muted small">
					在浏览器中打开站点的授权页面，用站点支持的任意方式登录（包括 GitHub、LinuxDO 等第三方账号）， 同意后 Pier
					会自动获得一个新令牌，不需要输入密码。需要站点支持并开启「应用授权」，否则请改用账号密码或访问令牌。
				</p>
			) : mode === "password" ? (
				<div className="form-grid">
					<label className="form-field">
						<span className="field-label">用户名或邮箱</span>
						<input autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
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
							<span className="field-label">用户 ID（旧版本需要）</span>
							<input
								inputMode="numeric"
								placeholder="可选"
								value={userId}
								onChange={(e) => setUserId(e.target.value.replace(/\D/g, ""))}
							/>
						</label>
					</div>
					<p className="muted small">
						使用 GitHub、LinuxDO 等第三方账号登录的用户，可以在 NewAPI「个人设置 → 安全设置 →
						系统访问令牌」中生成访问令牌。
					</p>
				</>
			)}
			{mode === "password" ? <p className="muted small">密码只用于这次登录，不会被保存。</p> : null}
			{errorBanner}
			<div className="modal-actions">
				<button type="submit" className="primary" disabled={busy}>
					{busy ? <IconLoader size={14} className="spin" /> : mode === "browser" ? <IconExternal size={14} /> : null}
					{mode === "browser" ? "在浏览器中授权" : "登录"}
				</button>
			</div>
		</form>
	);
}
