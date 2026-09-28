import {
	fromBase64Url,
	generateKeyPair,
	type KeyPair,
	keyFingerprint,
	keyPairFromSecret,
	toBase64Url,
} from "@pier/crypto";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { getItem, setItem } from "./storage.ts";

const DEVICE_KEY = "pier.deviceKey";
const DEVICE_NAME = "pier.deviceName";

/**
 * This device's long-term X25519 key. Generated on first launch and never leaves the
 * secure store; hosts identify the device by its public key.
 */
export async function loadDeviceKey(): Promise<KeyPair> {
	const saved = await getItem(DEVICE_KEY);
	if (saved) {
		try {
			return keyPairFromSecret(fromBase64Url(saved));
		} catch {
			// Corrupt entry: fall through and create a new identity (hosts must re-pair).
		}
	}
	const keyPair = generateKeyPair();
	await setItem(DEVICE_KEY, toBase64Url(keyPair.secretKey));
	return keyPair;
}

export function deviceFingerprint(keyPair: KeyPair): string {
	return keyFingerprint(keyPair.publicKey);
}

export function defaultDeviceName(): string {
	return (
		Device.deviceName ||
		Device.modelName ||
		(Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android 手机" : "浏览器")
	);
}

export async function loadDeviceName(): Promise<string> {
	return (await getItem(DEVICE_NAME)) || defaultDeviceName();
}

export async function saveDeviceName(name: string): Promise<void> {
	await setItem(DEVICE_NAME, name);
}

export function devicePlatform(): string {
	return Platform.OS;
}

export function deviceModel(): string | undefined {
	return Device.modelName ?? undefined;
}
