import { VOICE_LABELS } from "@pier/chat-state";
import type { useVoiceInput } from "../lib/use-voice-input.ts";
import { IconLoader, IconMic, IconStop, IconX } from "./Icons.tsx";

export function VoiceControls({ voice, disabled }: { voice: ReturnType<typeof useVoiceInput>; disabled?: boolean }) {
	const recording = voice.phase === "recording";
	const label = VOICE_LABELS[voice.phase];
	return (
		<div className="voice-controls">
			<button
				type="button"
				className={`ghost icon${recording ? " voice-recording" : ""}`}
				title={label}
				aria-label={label}
				aria-pressed={recording}
				disabled={disabled || (voice.busy && !recording)}
				onClick={recording ? voice.stop : voice.start}
			>
				{recording ? (
					<IconStop size={16} />
				) : voice.busy ? (
					<IconLoader size={16} className="spin" />
				) : (
					<IconMic size={16} />
				)}
			</button>
			{voice.busy ? (
				<>
					<span className="voice-status" role="status">
						{label}
					</span>
					<button
						type="button"
						className="ghost icon"
						title="取消语音输入"
						aria-label="取消语音输入"
						onClick={voice.cancel}
					>
						<IconX size={14} />
					</button>
				</>
			) : null}
		</div>
	);
}
