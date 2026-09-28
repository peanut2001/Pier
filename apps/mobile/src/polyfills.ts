/**
 * Hermes has no `crypto.getRandomValues`; `@noble/*` (device keys, Noise ephemerals)
 * needs it. expo-crypto provides a CSPRNG backed by the OS.
 */
import { getRandomValues } from "expo-crypto";

type RandomSource = { getRandomValues?: <T extends ArrayBufferView | null>(array: T) => T };
const g = globalThis as { crypto?: RandomSource };

if (typeof g.crypto?.getRandomValues !== "function") {
	const source: RandomSource = {
		getRandomValues: (array) => {
			if (array) getRandomValues(array as unknown as Uint8Array);
			return array;
		},
	};
	g.crypto = Object.assign(g.crypto ?? {}, source);
}
