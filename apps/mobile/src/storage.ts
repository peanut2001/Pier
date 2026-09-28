import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

/**
 * Small key-value storage for secrets and settings. On iOS / Android this is the
 * Keychain / Keystore (`expo-secure-store`, this device only, available after the first
 * unlock so reconnects work in the background). The web build (development only) falls
 * back to localStorage.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
	keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

const web = Platform.OS === "web";

export async function getItem(key: string): Promise<string | null> {
	if (web) return globalThis.localStorage?.getItem(key) ?? null;
	return SecureStore.getItemAsync(key, OPTIONS);
}

export async function setItem(key: string, value: string): Promise<void> {
	if (web) {
		globalThis.localStorage?.setItem(key, value);
		return;
	}
	await SecureStore.setItemAsync(key, value, OPTIONS);
}

export async function deleteItem(key: string): Promise<void> {
	if (web) {
		globalThis.localStorage?.removeItem(key);
		return;
	}
	await SecureStore.deleteItemAsync(key, OPTIONS);
}
