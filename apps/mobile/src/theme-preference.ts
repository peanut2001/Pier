import { useSyncExternalStore } from "react";
import { getItem, setItem } from "./storage.ts";

export type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "pier.theme";
const listeners = new Set<() => void>();
let preference: ThemePreference = "system";
let revision = 0;
let initialization: Promise<void> | undefined;
let saving = Promise.resolve();

function notify(): void {
	for (const listener of listeners) listener();
}

/** Restore the device preference without replacing a choice made during startup. */
export function initThemePreference(): Promise<void> {
	initialization ??= (async () => {
		const startedAt = revision;
		try {
			const saved = await getItem(THEME_KEY);
			if (revision !== startedAt) return;
			preference = saved === "light" || saved === "dark" ? saved : "system";
			notify();
		} catch {
			// Storage can be unavailable; the system theme still works.
		}
	})();
	return initialization;
}

/** Apply immediately; serialize storage writes so the last choice survives a restart. */
export async function setThemePreference(next: ThemePreference): Promise<void> {
	const previous = preference;
	const changedAt = ++revision;
	preference = next;
	notify();
	const write = saving.then(() => setItem(THEME_KEY, next));
	saving = write.catch(() => {});
	try {
		await write;
	} catch (error) {
		if (revision === changedAt) {
			preference = previous;
			notify();
		}
		throw error;
	}
}

export function getThemePreference(): ThemePreference {
	return preference;
}

export function useThemePreference(): ThemePreference {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getThemePreference,
		() => "system",
	);
}
