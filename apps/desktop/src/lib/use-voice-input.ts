import {
	startBrowserRecording,
	startPcmRecording,
	startSystemSpeechRecording,
	VoiceInput,
	type VoicePhase,
} from "@pier/chat-state";
import { useEffect, useRef, useState } from "react";
import { LOCAL_NODE, useStore } from "./store.tsx";
import { systemSpeech, systemSpeechPlatform, useSpeechProvider } from "./system-speech.ts";

export function useVoiceInput(scope: string, onText: (text: string) => void, disabled = false) {
	const store = useStore();
	const client = store.nodeClient(LOCAL_NODE);
	const provider = useSpeechProvider();
	const [phase, setPhase] = useState<VoicePhase>("idle");
	const callback = useRef(onText);
	callback.current = onText;
	const current = useRef<VoiceInput | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a draft change owns a new microphone operation.
	useEffect(() => {
		const voice = new VoiceInput({
			client,
			deviceSpeech: provider === "system" ? systemSpeech : undefined,
			record:
				provider === "system"
					? systemSpeechPlatform() === "macos"
						? startSystemSpeechRecording
						: startPcmRecording
					: startBrowserRecording,
			onPhase: setPhase,
			onText: (text) => callback.current(text),
			onError: (message) => store.toast("error", message),
		});
		current.current = voice;
		setPhase("idle");
		const hide = () => {
			if (document.hidden) void voice.cancel();
		};
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.isComposing && voice.phase !== "idle") {
				event.preventDefault();
				event.stopPropagation();
				void voice.cancel();
			}
		};
		document.addEventListener("visibilitychange", hide);
		document.addEventListener("keydown", handleEscape, true);
		const off = client?.onState((state) => {
			if (provider === "service" && state !== "open") void voice.cancel();
		});
		return () => {
			voice.dispose();
			off?.();
			document.removeEventListener("visibilitychange", hide);
			document.removeEventListener("keydown", handleEscape, true);
		};
	}, [client, scope, store, provider]);
	useEffect(() => {
		if (disabled) void current.current?.cancel();
	}, [disabled]);
	return {
		phase,
		busy: phase !== "idle",
		start: () => {
			if (!disabled) void current.current?.start();
		},
		stop: () => void current.current?.stop(),
		cancel: () => void current.current?.cancel(),
	};
}
