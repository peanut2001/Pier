import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeSpeechWav, startPcmRecording } from "../src/pcm-audio.ts";

afterEach(() => vi.unstubAllGlobals());

describe("speech PCM capture", () => {
	it.each([16_000, 44_100, 48_000])("writes a one-second mono PCM WAV at %i Hz input", (sampleRate) => {
		const bytes = encodeSpeechWav(new Float32Array(sampleRate).fill(0.5), sampleRate);
		const view = new DataView(bytes.buffer);
		expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(bytes.length - 8);
		expect(new TextDecoder().decode(bytes.subarray(8, 16))).toBe("WAVEfmt ");
		expect(view.getUint16(20, true)).toBe(1);
		expect(view.getUint16(22, true)).toBe(1);
		expect(view.getUint32(24, true)).toBe(16_000);
		expect(view.getUint16(34, true)).toBe(16);
		expect(view.getUint32(40, true)).toBe(32_000);
		expect(bytes.length).toBe(32_044);
		for (let offset = 44; offset < bytes.length; offset += 2) expect(view.getInt16(offset, true)).toBe(16_384);
	});

	it("clips samples and preserves negative full scale", () => {
		const bytes = encodeSpeechWav(new Float32Array([-2, -1, 0, 1, 2]), 16_000);
		const view = new DataView(bytes.buffer);
		expect(Array.from({ length: 5 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([
			-32768, -32768, 0, 32767, 32767,
		]);
	});

	function capture() {
		const track = { stop: vi.fn(), onended: null as null | (() => void) };
		const stream = { getTracks: () => [track] };
		const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
		const processor = { ...node(), onaudioprocess: null as null | ((event: unknown) => void) };
		const context = {
			sampleRate: 48_000,
			state: "running",
			onstatechange: null as null | (() => void),
			destination: {},
			createMediaStreamSource: vi.fn(node),
			createScriptProcessor: vi.fn(() => processor),
			createGain: vi.fn(() => ({ ...node(), gain: { value: 1 } })),
			resume: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		vi.stubGlobal(
			"AudioContext",
			class {
				constructor() {
					Object.assign(this, context);
				}
			},
		);
		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
		const samples = (data = new Float32Array(4800).fill(0.5)) =>
			processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => data } });
		return { track, processor, context, samples };
	}

	it("releases microphone and audio graph after stop, and returns an actual WAV", async () => {
		const t = capture();
		const recording = await startPcmRecording(new AbortController().signal, vi.fn());
		t.samples();
		const clip = await recording.stop();
		expect(clip.mimeType).toBe("audio/wav");
		expect(atob(clip.data).slice(0, 4)).toBe("RIFF");
		expect(atob(clip.data).length).toBe(3244);
		expect(t.track.stop).toHaveBeenCalled();
		expect(t.context.close).toHaveBeenCalledOnce();
		expect(t.processor.disconnect).toHaveBeenCalled();
		expect(t.processor.onaudioprocess).toBeNull();
		await recording.cancel();
		expect(t.context.close).toHaveBeenCalledOnce();
	});

	it("releases a microphone acquired after cancellation without starting an audio context", async () => {
		const t = capture();
		const operation = new AbortController();
		operation.abort();
		await expect(startPcmRecording(operation.signal, vi.fn())).rejects.toThrow("取消");
		expect(t.track.stop).toHaveBeenCalled();
		expect(t.context.createScriptProcessor).not.toHaveBeenCalled();
	});

	it("discards cancelled audio and reports a disconnected microphone once", async () => {
		const t = capture();
		const onError = vi.fn();
		const recording = await startPcmRecording(new AbortController().signal, onError);
		t.samples();
		t.track.onended?.();
		t.track.onended?.();
		expect(onError).toHaveBeenCalledOnce();
		await expect(recording.stop()).rejects.toThrow("断开");
		expect(t.track.stop).toHaveBeenCalled();
	});
});
