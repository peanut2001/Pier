import {
	type AuthNotice,
	type AuthPromptInfo,
	CUSTOM_PROVIDER_APIS,
	type CustomModel,
	type CustomProvider,
	type CustomProviderApi,
	type ModelInfo,
	type ProviderInfo,
} from "@pier/protocol";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { type AuthFlowState, useAppState, useStore, type YunlianLoginState } from "../lib/store.tsx";
import { isYunlianProvider, YUNLIAN_NAME, YUNLIAN_SITE, yunlianGroupOf } from "../lib/yunlian.ts";
import {
	IconAlert,
	IconCheck,
	IconDownload,
	IconExternal,
	IconKey,
	IconLoader,
	IconPencil,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconSparkles,
	IconTrash,
	IconUser,
	IconX,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";
import { SettingRow, SettingsCard, SettingsGroup } from "./SettingsUi.tsx";

/** Providers listed first when adding one. */
const POPULAR = [
	"anthropic",
	"openai",
	"openai-codex",
	"google",
	"github-copilot",
	"openrouter",
	"deepseek",
	"xai",
	"moonshotai-cn",
	"zai-coding-cn",
	"qwen-token-plan-cn",
	"minimax-cn",
];

const API_LABEL: Record<CustomProviderApi, string> = {
	"openai-completions": "OpenAI 兼容（Chat Completions）",
	"openai-responses": "OpenAI Responses",
	"anthropic-messages": "Anthropic 兼容（Messages）",
	"google-generative-ai": "Google Gemini",
};

const BASE_URL_HINT: Record<CustomProviderApi, string> = {
	"openai-completions": "https://api.example.com/v1",
	"openai-responses": "https://api.example.com/v1",
	"anthropic-messages": "https://api.example.com",
	"google-generative-ai": "https://generativelanguage.googleapis.com/v1beta",
};

const BASE_URL_NOTE: Record<CustomProviderApi, string> = {
	"openai-completions": "通常以 /v1 结尾，Pier 会请求 <Base URL>/chat/completions。",
	"openai-responses": "通常以 /v1 结尾，Pier 会请求 <Base URL>/responses。",
	"anthropic-messages": "不要带 /v1，Pier 会请求 <Base URL>/v1/messages。",
	"google-generative-ai": "Gemini API 的根地址（含版本号）。",
};

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
/** Credential sources the host can remove from models.json (`provider.logout`). */
const MODELS_JSON_SOURCES: ReadonlySet<string> = new Set(["models_json_key", "models_json_command"]);

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sourceText(provider: ProviderInfo): string {
	const { status } = provider;
	if (!status.configured) return "未配置";
	const kind = status.type === "oauth" ? (provider.oauth?.subscription ? "账号订阅" : "账号登录") : "API Key";
	switch (status.source) {
		case "stored":
			return `${kind} · 已保存`;
		case "environment":
			return `环境变量${status.label ? ` ${status.label}` : ""}`;
		case "models_json_key":
			return "models.json 中的密钥";
		case "models_json_command":
			return "models.json 中的密钥命令";
		case "runtime":
			return "临时密钥";
		default:
			return status.label ? `${kind} · ${status.label}` : kind;
	}
}

function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[-._]+|[-._]+$/g, "")
		.slice(0, 64);
}

// ---- default model ---------------------------------------------------------------------

function DefaultModelField() {
	const store = useStore();
	const providers = useAppState((s) => s.providers);
	const [models, setModels] = useState<ModelInfo[] | undefined>();
	const version = providers
		? `${providers.availableCount}|${providers.providers.map((p) => p.availableCount).join()}`
		: "";

	useEffect(() => {
		if (!version) return;
		store
			.availableModels()
			.then(setModels)
			.catch(() => setModels([]));
	}, [store, version]);

	if (!providers) return null;
	const current = providers.defaultModel;
	const value = current ? `${current.provider}\u0000${current.modelId}` : "";
	const groups = new Map<string, ModelInfo[]>();
	for (const model of models ?? []) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
	const names = new Map(providers.providers.map((p) => [p.id, p.name]));
	const known = models?.some((m) => `${m.provider}\u0000${m.id}` === value);

	if (providers.availableCount === 0) {
		return (
			<div className="models-empty">
				<IconAlert size={16} />
				<span>还没有可用的模型。在下面登录一个服务商，或添加一个自定义接口。</span>
			</div>
		);
	}
	return (
		<SettingsCard>
			<SettingRow
				title="新会话的默认模型"
				description={`共 ${providers.availableCount} 个可用模型。会话中可以随时切换模型，这里只影响新会话。`}
			>
				<select
					className="setting-select"
					value={value}
					onChange={(e) => {
						const [provider, modelId] = e.target.value.split("\u0000");
						if (provider && modelId) void store.setDefaultModel(provider, modelId);
					}}
				>
					{!current || !known ? (
						<option value={value}>{current ? `${current.provider}/${current.modelId}（不可用）` : "未设置"}</option>
					) : null}
					{[...groups].map(([provider, list]) => (
						<optgroup key={provider} label={names.get(provider) ?? provider}>
							{list.map((model) => (
								<option key={model.id} value={`${model.provider}\u0000${model.id}`}>
									{model.name && model.name !== model.id ? `${model.name}（${model.id}）` : model.id}
								</option>
							))}
						</optgroup>
					))}
				</select>
			</SettingRow>
		</SettingsCard>
	);
}

// ---- provider rows ---------------------------------------------------------------------

function ConfiguredRow({ provider, onEdit }: { provider: ProviderInfo; onEdit: (p: ProviderInfo) => void }) {
	const store = useStore();
	const [confirm, setConfirm] = useState(false);
	const custom = provider.custom;
	const removable = provider.stored || MODELS_JSON_SOURCES.has(provider.status.source ?? "");
	return (
		<div className="provider-row">
			<span className={`status-dot ${provider.status.configured ? "ok" : "bad"}`} />
			<div className="provider-main">
				<div className="provider-name">
					{provider.name}
					{custom ? <span className="mini-tag">自定义</span> : null}
				</div>
				<div className="muted small">
					{provider.status.configured ? sourceText(provider) : "缺少凭据"} ·{" "}
					{provider.availableCount
						? `${provider.availableCount} 个模型可用`
						: provider.modelCount
							? `${provider.modelCount} 个模型`
							: "没有模型"}
					{custom ? <span className="mono"> · {custom.baseUrl}</span> : null}
				</div>
			</div>
			<div className="row-actions">
				{yunlianGroupOf(provider) !== undefined ? (
					<button
						type="button"
						className="ghost"
						title="在个人中心更新这个分组的令牌和模型"
						onClick={() => store.openSettings("account")}
					>
						<IconUser size={13} />
						个人中心
					</button>
				) : isYunlianProvider(provider) ? (
					<button
						type="button"
						className="ghost"
						title="在浏览器中重新授权，更新令牌和模型列表"
						onClick={() => void store.loginYunlian()}
					>
						<IconExternal size={13} />
						重新登录
					</button>
				) : null}
				{custom ? (
					<button type="button" className="ghost" onClick={() => onEdit(provider)}>
						<IconPencil size={13} />
						编辑
					</button>
				) : null}
				{custom ? (
					<button
						type="button"
						className={confirm ? "danger" : "ghost"}
						onBlur={() => setConfirm(false)}
						onClick={() => {
							if (!confirm) {
								setConfirm(true);
								return;
							}
							void store.removeCustomProvider(provider);
						}}
					>
						<IconTrash size={13} />
						{confirm ? "确认删除" : "删除"}
					</button>
				) : removable ? (
					<button
						type="button"
						className={confirm ? "danger" : "ghost"}
						title={provider.stored ? undefined : "从 models.json 中删除这个服务商的 apiKey"}
						onBlur={() => setConfirm(false)}
						onClick={() => {
							if (!confirm) {
								setConfirm(true);
								return;
							}
							void store.logoutProvider(provider);
						}}
					>
						{confirm ? "确认移除" : provider.status.type === "oauth" ? "退出登录" : "移除密钥"}
					</button>
				) : null}
			</div>
		</div>
	);
}

function LoginButtons({ provider }: { provider: ProviderInfo }) {
	const store = useStore();
	if (!provider.apiKey?.interactive && !provider.oauth) {
		return <span className="muted small">通过环境变量或云凭据配置</span>;
	}
	return (
		<div className="row-actions">
			{provider.oauth ? (
				<button type="button" onClick={() => void store.startLogin(provider, "oauth")}>
					{provider.oauth.loginLabel ?? (provider.oauth.subscription ? "订阅账号登录" : "账号登录")}
				</button>
			) : null}
			{provider.apiKey?.interactive ? (
				<button type="button" onClick={() => void store.startLogin(provider, "api_key")}>
					<IconKey size={13} />
					API Key
				</button>
			) : null}
		</div>
	);
}

/** 云链API, listed first: signing in only takes a browser authorization. */
function YunlianRow() {
	const store = useStore();
	return (
		<div className="provider-row">
			<div className="provider-main">
				<div className="provider-name">
					{YUNLIAN_NAME}
					<span className="mini-tag">推荐</span>
				</div>
				<div className="muted small">
					<span className="mono">{new URL(YUNLIAN_SITE).host}</span> · 在浏览器中登录授权，自动获取令牌和全部模型
				</div>
			</div>
			<div className="row-actions">
				<button type="button" title="登录账号，查看余额，按分组配置令牌" onClick={() => store.openSettings("account")}>
					<IconUser size={13} />
					个人中心
				</button>
				<button type="button" className="primary" onClick={() => void store.loginYunlian()}>
					<IconExternal size={13} />
					浏览器登录
				</button>
			</div>
		</div>
	);
}

const YUNLIAN_KEYWORDS = `yunlian yunnet newapi ${YUNLIAN_NAME} ${YUNLIAN_SITE}`.toLowerCase();

function AddProviderList({ providers, yunlian }: { providers: ProviderInfo[]; yunlian: boolean }) {
	const [filter, setFilter] = useState("");
	const [showAll, setShowAll] = useState(false);
	const query = filter.trim().toLowerCase();
	const sorted = useMemo(() => {
		const rank = (p: ProviderInfo) => {
			const i = POPULAR.indexOf(p.id);
			return i === -1 ? POPULAR.length : i;
		};
		return [...providers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	}, [providers]);
	const matches = sorted.filter((p) => !query || `${p.id} ${p.name}`.toLowerCase().includes(query));
	const visible = query || showAll ? matches : matches.slice(0, 8);
	const showYunlian = yunlian && (!query || YUNLIAN_KEYWORDS.includes(query));
	return (
		<>
			<div className="provider-search">
				<IconSearch size={14} />
				<input
					placeholder="搜索服务商，例如 anthropic、openrouter、deepseek"
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
				/>
			</div>
			<div className="provider-list">
				{showYunlian ? <YunlianRow /> : null}
				{visible.map((provider) => (
					<div key={provider.id} className="provider-row">
						<div className="provider-main">
							<div className="provider-name">{provider.name}</div>
							<div className="muted small mono">{provider.id}</div>
						</div>
						<LoginButtons provider={provider} />
					</div>
				))}
				{!visible.length && !showYunlian ? <div className="provider-row muted small">没有匹配的服务商。</div> : null}
			</div>
			{!query && !showAll && matches.length > visible.length ? (
				<button type="button" className="ghost show-all" onClick={() => setShowAll(true)}>
					显示全部 {matches.length} 个服务商
				</button>
			) : null}
		</>
	);
}

function ProviderList({ onCustom }: { onCustom: (provider?: ProviderInfo) => void }) {
	const store = useStore();
	const providers = useAppState((s) => s.providers);
	if (!providers) return <p className="muted">正在读取模型配置…</p>;
	const configured = providers.providers.filter((p) => p.status.configured || p.stored || p.custom);
	const others = providers.providers.filter((p) => !configured.includes(p));
	const hasYunlian = configured.some(isYunlianProvider);
	return (
		<>
			<p className="settings-intro">
				Pier 使用 pi 的模型配置，凭据保存在这台电脑的 <code>{providers.agentDir}</code> 中，与终端里的 pi 共用。
			</p>
			{providers.error ? (
				<div className="banner error inline models-error">
					<IconAlert size={15} />
					<span>{providers.error}</span>
				</div>
			) : null}
			<SettingsGroup title="默认模型">
				<DefaultModelField />
			</SettingsGroup>
			<SettingsGroup
				title={`已配置的服务商（${configured.length}）`}
				actions={
					<button type="button" className="ghost" onClick={() => void store.loadProviders()}>
						<IconRefresh size={13} />
						刷新
					</button>
				}
			>
				{configured.length ? (
					<div className="provider-list">
						{configured.map((provider) => (
							<ConfiguredRow key={provider.id} provider={provider} onEdit={onCustom} />
						))}
					</div>
				) : (
					<SettingsCard>
						<div className="settings-empty">还没有配置任何服务商。</div>
					</SettingsCard>
				)}
			</SettingsGroup>
			<SettingsGroup
				title="添加服务商"
				actions={
					<button type="button" className="primary" onClick={() => onCustom()}>
						<IconPlus size={14} />
						自定义接口
					</button>
				}
			>
				<p className="muted small settings-note">
					使用其他中转站、公司网关或本地模型（Ollama、LM Studio、vLLM 等）时，选择「自定义接口」填写 Base URL 和 API
					Key。
				</p>
				<AddProviderList providers={others} yunlian={!hasYunlian} />
			</SettingsGroup>
		</>
	);
}

// ---- sign-in ---------------------------------------------------------------------------

function NoticeView({ notice }: { notice: AuthNotice }) {
	const store = useStore();
	if (notice.type === "auth_url") {
		return (
			<div className="auth-notice">
				<div>{notice.instructions ?? "已在浏览器中打开登录页面，完成授权后回到这里。"}</div>
				<div className="row-actions">
					<button type="button" onClick={() => store.openExternal(notice.url)}>
						<IconExternal size={13} />
						重新打开浏览器
					</button>
					<CopyButton text={notice.url} label="复制登录链接" />
				</div>
			</div>
		);
	}
	if (notice.type === "device_code") {
		return (
			<div className="auth-notice">
				<div>在浏览器中打开下面的地址，输入验证码：</div>
				<div className="device-code mono">{notice.userCode}</div>
				<div className="row-actions">
					<button type="button" onClick={() => store.openExternal(notice.verificationUri)}>
						<IconExternal size={13} />
						打开 {notice.verificationUri}
					</button>
					<CopyButton text={notice.userCode} label="复制验证码" />
				</div>
			</div>
		);
	}
	if (notice.type === "info") {
		return (
			<div className="auth-notice">
				<div>{notice.message}</div>
				{notice.links?.length ? (
					<div className="row-actions">
						{notice.links.map((link) => (
							<button key={link.url} type="button" className="ghost" onClick={() => store.openExternal(link.url)}>
								<IconExternal size={13} />
								{link.label ?? link.url}
							</button>
						))}
					</div>
				) : null}
			</div>
		);
	}
	return <div className="auth-notice muted">{notice.message}</div>;
}

function PromptForm({ prompt }: { prompt: AuthPromptInfo }) {
	const store = useStore();
	const [value, setValue] = useState("");
	const submit = (e: FormEvent) => {
		e.preventDefault();
		if (value.trim()) void store.answerAuthPrompt(value.trim());
	};
	if (prompt.type === "select") {
		return (
			<div className="auth-prompt">
				<div className="field-label">{prompt.message}</div>
				<div className="provider-list">
					{prompt.options?.map((option) => (
						<button
							key={option.id}
							type="button"
							className="provider-row option-row"
							onClick={() => void store.answerAuthPrompt(option.id)}
						>
							<span className="provider-main">
								<span className="provider-name">{option.label}</span>
								{option.description ? <span className="muted small">{option.description}</span> : null}
							</span>
						</button>
					))}
				</div>
			</div>
		);
	}
	return (
		<form className="auth-prompt" onSubmit={submit}>
			<label className="field-label" htmlFor="auth-input">
				{prompt.message}
			</label>
			<div className="auth-input-row">
				<input
					id="auth-input"
					// biome-ignore lint/a11y/noAutofocus: the dialog asks exactly this question.
					autoFocus
					type={prompt.type === "secret" ? "password" : "text"}
					autoComplete="off"
					spellCheck={false}
					placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? "粘贴授权码或跳转后的完整网址" : "")}
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
				<button type="submit" className="primary" disabled={!value.trim()}>
					确定
				</button>
			</div>
			{prompt.type === "secret" ? (
				<p className="muted small">密钥只保存在这台电脑的 pi 配置目录（auth.json，仅当前用户可读）。</p>
			) : null}
		</form>
	);
}

function LoginView({ auth }: { auth: AuthFlowState }) {
	const store = useStore();
	const waiting = !auth.error && !auth.prompt;
	return (
		<div className="login-view">
			<p className="muted">
				{auth.method === "oauth" ? "使用账号登录" : "填写 API Key"}：<strong>{auth.providerName}</strong>
			</p>
			{auth.notices.map((notice, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: notices are append-only.
				<NoticeView key={i} notice={notice} />
			))}
			{auth.prompt ? <PromptForm key={auth.prompt.id} prompt={auth.prompt} /> : null}
			{waiting ? (
				<div className="auth-waiting muted">
					<IconLoader size={15} className="spin" />
					{auth.flowId ? "等待完成…" : "正在启动…"}
				</div>
			) : null}
			{auth.error ? (
				<div className="banner error inline">
					<IconAlert size={15} />
					<span>{auth.error}</span>
				</div>
			) : null}
			<div className="modal-actions">
				<button type="button" onClick={() => void store.cancelLogin()}>
					{auth.error ? "关闭" : "取消"}
				</button>
				{auth.error ? (
					<button
						type="button"
						className="primary"
						onClick={() => {
							const provider = store.getState().providers?.providers.find((p) => p.id === auth.providerId);
							if (provider) void store.startLogin(provider, auth.method);
						}}
					>
						重试
					</button>
				) : null}
			</div>
		</div>
	);
}

// ---- custom endpoint -------------------------------------------------------------------

interface ModelRow extends CustomModel {
	key: number;
}

let nextRowKey = 1;
const row = (model: CustomModel): ModelRow => ({ ...model, key: nextRowKey++ });

/** Most models a custom provider may list (see `CustomProviderSchema`). */
const MAX_MODELS = 500;

function CustomProviderForm({ editing, onDone }: { editing?: ProviderInfo; onDone: () => void }) {
	const store = useStore();
	const providers = useAppState((s) => s.providers);
	const initial = editing?.custom;
	const [name, setName] = useState(initial?.name ?? editing?.name ?? "");
	const [id, setId] = useState(initial?.id ?? "");
	const [idTouched, setIdTouched] = useState(Boolean(initial));
	const [api, setApi] = useState<CustomProviderApi>(initial?.api ?? "openai-completions");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<ModelRow[]>(() => (initial?.models ?? [{ id: "" }]).map(row));
	const [probe, setProbe] = useState<{ busy?: boolean; error?: string; models?: CustomModel[] }>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	const effectiveId = idTouched ? id : slugify(name) || "";
	const hasKey = Boolean(editing && (editing.stored || initial?.hasConfiguredKey));
	const taken = !editing && effectiveId ? providers?.providers.some((p) => p.id === effectiveId) === true : false;
	const ids = new Set(models.map((m) => m.id.trim()).filter(Boolean));

	const update = (key: number, patch: Partial<CustomModel>) =>
		setModels((list) => list.map((m) => (m.key === key ? { ...m, ...patch } : m)));

	const runProbe = async () => {
		setProbe({ busy: true });
		try {
			const found = await store.probeModels({
				api,
				baseUrl: baseUrl.trim(),
				...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
				...(editing ? { providerId: editing.id } : {}),
			});
			setProbe({ models: found });
		} catch (e) {
			setProbe({ error: errorText(e) });
		}
	};

	// Probed models carry the capabilities the host found in pi's model catalog.
	const addModels = (list: CustomModel[]) =>
		setModels((current) => {
			const kept = current.filter((m) => m.id.trim());
			const have = new Set(kept.map((m) => m.id.trim()));
			return [...kept, ...list.filter((m) => !have.has(m.id)).map((m) => row({ ...m }))];
		});

	const validate = (cleaned: CustomModel[]): string | undefined => {
		if (!PROVIDER_ID_RE.test(effectiveId)) return "ID 只能包含小写字母、数字、“.”、“_”和“-”，并以字母或数字开头";
		if (taken) return `ID “${effectiveId}” 已被使用，请换一个`;
		if (!/^https?:\/\/\S+$/i.test(baseUrl.trim())) return "Base URL 必须以 http:// 或 https:// 开头";
		if (cleaned.length > MAX_MODELS) return `最多添加 ${MAX_MODELS} 个模型`;
		if (!editing && !apiKey.trim()) return "请填写 API Key（本地服务不需要密钥时可以随便填，例如 ollama）";
		if (!cleaned.length) return "至少添加一个模型";
		return undefined;
	};

	const save = async (e: FormEvent) => {
		e.preventDefault();
		const cleaned: CustomModel[] = models
			.map(({ key: _k, name: modelName, ...m }) => ({
				...m,
				id: m.id.trim(),
				...(modelName?.trim() ? { name: modelName.trim() } : {}),
			}))
			.filter((m) => m.id);
		const invalid = validate(cleaned);
		setError(invalid);
		if (invalid) return;
		const provider: CustomProvider = {
			id: effectiveId,
			...(name.trim() ? { name: name.trim() } : {}),
			api,
			baseUrl: baseUrl.trim(),
			models: cleaned,
		};
		setSaving(true);
		try {
			await store.saveCustomProvider(provider, { apiKey: apiKey.trim() || undefined }, !editing);
			onDone();
		} catch (err) {
			setError(errorText(err));
		} finally {
			setSaving(false);
		}
	};

	return (
		<form className="custom-form" onSubmit={(e) => void save(e)}>
			<div className="form-grid">
				<label className="form-field">
					<span className="field-label">名称</span>
					<input
						// biome-ignore lint/a11y/noAutofocus: first field of the form.
						autoFocus={!editing}
						placeholder="例如 我的中转站"
						value={name}
						maxLength={100}
						onChange={(e) => setName(e.target.value)}
					/>
				</label>
				<label className="form-field">
					<span className="field-label">ID</span>
					<input
						className="mono"
						placeholder="my-proxy"
						value={effectiveId}
						disabled={Boolean(editing)}
						maxLength={64}
						onChange={(e) => {
							setIdTouched(true);
							setId(e.target.value.toLowerCase());
						}}
					/>
				</label>
				<label className="form-field">
					<span className="field-label">接口类型</span>
					<select value={api} onChange={(e) => setApi(e.target.value as CustomProviderApi)}>
						{CUSTOM_PROVIDER_APIS.map((value) => (
							<option key={value} value={value}>
								{API_LABEL[value]}
							</option>
						))}
					</select>
				</label>
				<label className="form-field">
					<span className="field-label">Base URL</span>
					<input
						className="mono"
						placeholder={BASE_URL_HINT[api]}
						value={baseUrl}
						spellCheck={false}
						onChange={(e) => setBaseUrl(e.target.value)}
					/>
				</label>
				<label className="form-field wide">
					<span className="field-label">API Key</span>
					<input
						type="password"
						autoComplete="off"
						spellCheck={false}
						placeholder={hasKey ? "已保存，留空则保持不变" : "sk-…"}
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
					/>
				</label>
			</div>
			<p className="muted small">{BASE_URL_NOTE[api]}</p>

			<div className="field">
				<div className="section-row">
					<div className="field-label">模型（{ids.size}）</div>
					<div className="row-actions">
						<button
							type="button"
							disabled={probe.busy || !/^https?:\/\/\S+$/i.test(baseUrl.trim())}
							onClick={() => void runProbe()}
							title="请求 <Base URL>/models 获取模型列表"
						>
							{probe.busy ? <IconLoader size={13} className="spin" /> : <IconDownload size={13} />}
							从接口获取
						</button>
						<button type="button" onClick={() => setModels((list) => [...list, row({ id: "" })])}>
							<IconPlus size={13} />
							手动添加
						</button>
					</div>
				</div>
				{probe.error ? <div className="error-text small probe-error">{probe.error}</div> : null}
				{probe.models ? (
					<div className="probe-result">
						<div className="muted small">
							接口返回 {probe.models.length} 个模型，点击添加：
							{probe.models.some((m) => !ids.has(m.id)) ? (
								<button type="button" className="ghost link-button" onClick={() => addModels(probe.models ?? [])}>
									全部添加
								</button>
							) : null}
						</div>
						<div className="chips">
							{probe.models.map((m) => {
								const added = ids.has(m.id);
								return (
									<button
										key={m.id}
										type="button"
										className={`chip-button${added ? " added" : ""}`}
										disabled={added}
										onClick={() => addModels([m])}
										title={m.name ?? m.id}
									>
										{added ? <IconCheck size={12} /> : <IconPlus size={12} />}
										{m.id}
									</button>
								);
							})}
						</div>
					</div>
				) : null}
				<div className="model-rows">
					<div className="model-row head muted small">
						<span>模型 ID</span>
						<span>显示名称</span>
						<span title="上下文窗口（tokens），留空为 128000">上下文</span>
						<span>推理</span>
						<span>图片</span>
						<span />
					</div>
					{models.map((m) => (
						<div key={m.key} className="model-row">
							<input
								className="mono"
								placeholder="gpt-4o"
								value={m.id}
								spellCheck={false}
								onChange={(e) => update(m.key, { id: e.target.value })}
							/>
							<input
								placeholder="可选"
								value={m.name ?? ""}
								onChange={(e) => update(m.key, { name: e.target.value })}
							/>
							<input
								inputMode="numeric"
								placeholder="128000"
								value={m.contextWindow ?? ""}
								onChange={(e) => {
									const n = Number(e.target.value.replace(/\D/g, ""));
									update(m.key, { contextWindow: n > 0 ? n : undefined });
								}}
							/>
							<input
								type="checkbox"
								title="推理模型（支持思考等级）"
								checked={m.reasoning === true}
								onChange={(e) => update(m.key, { reasoning: e.target.checked })}
							/>
							<input
								type="checkbox"
								title="支持图片输入"
								checked={m.images === true}
								onChange={(e) => update(m.key, { images: e.target.checked })}
							/>
							<button
								type="button"
								className="ghost icon"
								title="移除"
								onClick={() => setModels((list) => list.filter((x) => x.key !== m.key))}
							>
								<IconX size={14} />
							</button>
						</div>
					))}
				</div>
				<p className="muted small">
					常见模型的推理、图片与上下文会按 pi 内置的模型目录自动识别；手动修改过的设置保持不变。
				</p>
			</div>
			{error ? (
				<div className="banner error inline">
					<IconAlert size={15} />
					<span>{error}</span>
				</div>
			) : null}
			<div className="modal-actions">
				<button type="button" onClick={onDone}>
					返回
				</button>
				<button type="submit" className="primary" disabled={saving}>
					{saving ? <IconLoader size={14} className="spin" /> : null}
					{editing ? "保存" : "添加"}
				</button>
			</div>
		</form>
	);
}

// ---- settings page ---------------------------------------------------------------------

/** The “models and providers” settings page. */
export function ModelsSettings() {
	const [custom, setCustom] = useState<{ provider?: ProviderInfo } | undefined>();
	return (
		<>
			<ProviderList onCustom={(provider) => setCustom(provider ? { provider } : {})} />
			{custom ? (
				<Modal
					title={custom.provider ? `编辑 · ${custom.provider.name}` : "添加自定义接口"}
					onClose={() => setCustom(undefined)}
					wide
				>
					<CustomProviderForm editing={custom.provider} onDone={() => setCustom(undefined)} />
				</Modal>
			) : null}
		</>
	);
}

/** Provider sign-in dialog (API key or account login), shown over whatever is on screen. */
export function AuthDialog() {
	const store = useStore();
	const auth = useAppState((s) => s.auth);
	if (!auth) return null;
	return (
		<Modal
			title={`${auth.method === "oauth" ? "账号登录" : "API Key"} · ${auth.providerName}`}
			onClose={() => void store.cancelLogin()}
		>
			<LoginView auth={auth} />
		</Modal>
	);
}

function YunlianView({ login }: { login: YunlianLoginState }) {
	const store = useStore();
	const { authorizeUrl, saving, error } = login;
	return (
		<div className="login-view">
			{error ? null : authorizeUrl ? (
				<div className="auth-notice">
					<div>
						已在浏览器中打开{YUNLIAN_NAME}的授权页面。请在浏览器中登录（账号密码、GitHub、LinuxDO、Passkey
						等方式都可以）并点击「授权」，完成后会自动回到这里。
					</div>
					<div className="row-actions">
						<button type="button" onClick={() => store.openExternal(authorizeUrl)}>
							<IconExternal size={13} />
							重新打开浏览器
						</button>
						<CopyButton text={authorizeUrl} label="复制登录链接" />
					</div>
				</div>
			) : null}
			{error ? null : (
				<div className="auth-waiting muted">
					<IconLoader size={15} className="spin" />
					{saving ? "已授权，正在添加模型…" : authorizeUrl ? "等待浏览器中完成授权…" : "正在打开浏览器…"}
				</div>
			)}
			{error ? (
				<div className="banner error inline">
					<IconAlert size={15} />
					<span>{error}</span>
				</div>
			) : null}
			<p className="muted small">令牌密钥由 Pier Host 直接保存在本机的 pi 配置目录，不会显示在界面上。</p>
			<div className="modal-actions">
				<button type="button" onClick={() => store.cancelYunlian()} disabled={saving}>
					{error ? "关闭" : "取消"}
				</button>
				{error ? (
					<button type="button" className="primary" onClick={() => void store.loginYunlian()}>
						重试
					</button>
				) : null}
			</div>
		</div>
	);
}

/** 云链API browser sign-in dialog, shown over whatever is on screen. */
export function YunlianDialog() {
	const store = useStore();
	const login = useAppState((s) => s.yunlian);
	if (!login) return null;
	return (
		<Modal
			title={`浏览器登录 · ${YUNLIAN_NAME}`}
			onClose={() => {
				if (!login.saving) store.cancelYunlian();
			}}
		>
			<YunlianView login={login} />
		</Modal>
	);
}

/** Shown on the home screens while no model can be used. */
export function NoModelsBanner() {
	const store = useStore();
	const providers = useAppState((s) => s.providers);
	if (!providers || providers.availableCount > 0) return null;
	return (
		<div className="no-models">
			<div className="no-models-icon">
				<IconSparkles size={18} />
			</div>
			<div className="no-models-text">
				<div className="no-models-title">还没有可用的模型</div>
				<div className="muted small">
					登录{YUNLIAN_NAME}、Anthropic、OpenAI 等服务商，或添加中转站 / 本地模型的自定义接口。
				</div>
			</div>
			<button type="button" onClick={() => void store.loginYunlian()}>
				<IconExternal size={13} />
				登录{YUNLIAN_NAME}
			</button>
			<button type="button" className="primary" onClick={() => store.openModels()}>
				配置模型
			</button>
		</div>
	);
}
