/**
 * Spike 3 benchmark: cost of the secure channel on the current JS engine. Runs the
 * real code paths (Noise IK handshake, `SecureTransport.seal/open` including base64
 * and JSON framing), so numbers from Node, Bun and the mobile app are comparable.
 */
import { ChannelResponder, ConnectInitiator, type SecureTransport } from "./channel.ts";
import { generateKeyPair } from "./noise.ts";

export interface BenchResult {
	name: string;
	iterations: number;
	/** Mean milliseconds per iteration. */
	meanMs: number;
	/** Throughput for frame benchmarks, in MiB/s of plaintext (sealed + opened). */
	mibPerSecond?: number;
}

export interface BenchOptions {
	/** Rough time budget per case in ms (default 400). */
	budgetMs?: number;
	/** Frame sizes in bytes (default 1 KiB, 64 KiB, 1 MiB). */
	frameSizes?: number[];
	now?: () => number;
	/** Called between cases so UIs can update and yield. */
	onProgress?: (result: BenchResult) => void | Promise<void>;
}

function establish(): { device: SecureTransport; host: SecureTransport } {
	const hostKeys = generateKeyPair();
	const deviceKeys = generateKeyPair();
	const initiator = new ConnectInitiator({ deviceKeyPair: deviceKeys, hostPublicKey: hostKeys.publicKey });
	const responder = new ChannelResponder({
		hostKeyPair: hostKeys,
		hostHello: { hostId: "bench", hostName: "bench" },
		isKnownDevice: () => true,
		pairingOpen: () => false,
	});
	const step = responder.receive(initiator.start());
	if (step.kind !== "connected") throw new Error("unexpected handshake step");
	return { device: initiator.receive(step.frame), host: step.transport };
}

function sizeLabel(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${bytes / (1024 * 1024)} MiB`;
	if (bytes >= 1024) return `${bytes / 1024} KiB`;
	return `${bytes} B`;
}

async function measure(
	name: string,
	budgetMs: number,
	now: () => number,
	fn: () => void,
	bytes?: number,
): Promise<BenchResult> {
	fn(); // Warm up.
	let iterations = 0;
	const start = now();
	let elapsed = 0;
	do {
		fn();
		iterations++;
		elapsed = now() - start;
	} while (elapsed < budgetMs && iterations < 10_000);
	const meanMs = elapsed / iterations;
	return {
		name,
		iterations,
		meanMs,
		...(bytes ? { mibPerSecond: bytes / (1024 * 1024) / (meanMs / 1000) } : {}),
	};
}

export async function runChannelBenchmark(options: BenchOptions = {}): Promise<BenchResult[]> {
	const now = options.now ?? (() => (globalThis.performance ? globalThis.performance.now() : Date.now()));
	const budget = options.budgetMs ?? 400;
	const results: BenchResult[] = [];
	const push = async (result: BenchResult) => {
		results.push(result);
		await options.onProgress?.(result);
	};

	await push(await measure("X25519 key pair", budget, now, () => void generateKeyPair()));
	await push(await measure("Noise IK handshake (both sides)", budget, now, () => void establish()));

	const { device, host } = establish();
	for (const size of options.frameSizes ?? [1024, 64 * 1024, 1024 * 1024]) {
		// Realistic payload: JSON text, mostly ASCII with some CJK.
		const unit = '{"type":"evt","event":{"delta":"hello 你好 "}}';
		const text = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
		await push(
			await measure(
				`seal + open ${sizeLabel(size)} frame`,
				budget,
				now,
				() => {
					if (host.open(device.seal(text)).length !== text.length) throw new Error("roundtrip mismatch");
				},
				size,
			),
		);
	}
	return results;
}

export function formatBenchResults(results: BenchResult[]): string {
	return results
		.map((r) => {
			const throughput = r.mibPerSecond === undefined ? "" : `  ${r.mibPerSecond.toFixed(1)} MiB/s`;
			return `${r.name.padEnd(34)} ${r.meanMs.toFixed(3).padStart(9)} ms  (n=${r.iterations})${throughput}`;
		})
		.join("\n");
}
