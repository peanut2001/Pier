import { useSyncExternalStore } from "react";

/**
 * Light/dark appearance. The choice is kept per device in localStorage; "system" follows the
 * OS preference. The resolved theme is set as `data-theme` on <html>, which tokens.css reads.
 */
export type ThemePreference = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const THEME_KEY = "pier.theme";
const lightQuery = window.matchMedia?.("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
	const saved = localStorage.getItem(THEME_KEY);
	return saved === "light" || saved === "dark" ? saved : "system";
}

let preference = readPreference();

function resolve(): Theme {
	if (preference !== "system") return preference;
	return lightQuery?.matches ? "light" : "dark";
}

function apply(): void {
	const theme = resolve();
	if (document.documentElement.dataset.theme === theme) return;
	document.documentElement.dataset.theme = theme;
	for (const listener of listeners) listener();
}

/** Set `data-theme` before the first render and keep it following the OS in "system" mode. */
export function installTheme(): void {
	apply();
	lightQuery?.addEventListener?.("change", apply);
}

export function currentTheme(): Theme {
	return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Called whenever the resolved theme changes. Returns an unsubscribe function. */
export function onThemeChange(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function setThemePreference(next: ThemePreference): void {
	preference = next;
	if (next === "system") localStorage.removeItem(THEME_KEY);
	else localStorage.setItem(THEME_KEY, next);
	apply();
	for (const listener of listeners) listener();
}

export function useThemePreference(): ThemePreference {
	return useSyncExternalStore(onThemeChange, () => preference);
}
