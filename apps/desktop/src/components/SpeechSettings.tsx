import { requireSpeechClient } from "@pier/chat-state";
import { SpeechMethodSchemas, type SpeechStatus } from "@pier/protocol";
import { useEffect, useState } from "react";
import { LOCAL_NODE, useStore } from "../lib/store.tsx";

export function SpeechSettings() {
	const store = useStore();
	const client = store.nodeClient(LOCAL_NODE);
	const [settings, setSettings] = useState<SpeechStatus>();
	const [key, setKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState("");
	useEffect(() => {
		let active = true;
		void (async () => {
			try {
				const result = await requireSpeechClient(client).request("speech.status");
				if (active) setSettings(result);
			} catch (error) {
				if (active) setMessage(error instanceof Error ? error.message : "读取失败");
			}
		})();
		return () => {
			active = false;
		};
	}, [client]);
	return (
		<form
			className="speech-settings"
			onSubmit={async (event) => {
				event.preventDefault();
				if (!settings || pending) return;
				setPending(true);
				setMessage("");
				try {
					const parsed = SpeechMethodSchemas["speech.configure"].safeParse({
						...settings,
						apiKey: removeKey ? "" : key || undefined,
					});
					if (!parsed.success) throw new Error("请检查接口地址、模型和语言代码（留空或填写 zh、en 等两字母代码）");
					const result = await requireSpeechClient(client).request("speech.configure", parsed.data);
					setSettings(result);
					setKey("");
					setRemoveKey(false);
					setMessage("语音设置已保存");
				} catch (error) {
					setMessage(error instanceof Error ? error.message : "保存失败");
				} finally {
					setPending(false);
				}
			}}
		>
			<p className="muted">
				录音发送到你配置的语音转文字服务。配置保存在本机，已配对的手机也可使用；每次最多录音 2
				分钟。识别后可编辑文字再发送。
			</p>
			{settings ? (
				<>
					<label>
						接口地址
						<input
							aria-label="语音接口地址"
							type="url"
							value={settings.url}
							placeholder="https://example.com/v1/audio/transcriptions"
							disabled={pending}
							onChange={(event) => setSettings({ ...settings, url: event.target.value })}
						/>
					</label>
					<span className="muted">填写完整的 OpenAI 兼容转写地址；更换地址时请重新填写 API Key。留空可停用。</span>
					<label>
						模型
						<input
							aria-label="语音模型"
							value={settings.model}
							required
							disabled={pending}
							onChange={(event) => setSettings({ ...settings, model: event.target.value })}
						/>
					</label>
					<label>
						API Key
						<input
							aria-label="语音 API Key"
							type="password"
							autoComplete="new-password"
							value={key}
							disabled={pending || removeKey}
							placeholder={settings.hasApiKey ? "已保存，留空保留" : "本地服务可留空"}
							onChange={(event) => setKey(event.target.value)}
						/>
					</label>
					{settings.hasApiKey ? (
						<label>
							<input
								type="checkbox"
								checked={removeKey}
								disabled={pending}
								onChange={(event) => setRemoveKey(event.target.checked)}
							/>
							移除已保存的 API Key
						</label>
					) : null}
					<label>
						识别语言
						<input
							aria-label="识别语言"
							value={settings.language}
							placeholder="自动检测（或 zh / en）"
							disabled={pending}
							onChange={(event) => setSettings({ ...settings, language: event.target.value })}
						/>
					</label>
					<button type="submit" disabled={pending}>
						{pending ? "保存中…" : "保存语音设置"}
					</button>
				</>
			) : null}
			{message ? <p role="status">{message}</p> : null}
		</form>
	);
}
