import { Platform, useColorScheme } from "react-native";

export interface Palette {
	bg: string;
	card: string;
	elevated: string;
	border: string;
	text: string;
	muted: string;
	faint: string;
	accent: string;
	accentSoft: string;
	onAccent: string;
	danger: string;
	dangerSoft: string;
	warning: string;
	warningSoft: string;
	ok: string;
	code: string;
	codeText: string;
	userBubble: string;
	add: string;
	del: string;
}

const dark: Palette = {
	bg: "#111317",
	card: "#171a20",
	elevated: "#1f232b",
	border: "#262b34",
	text: "#e6e8eb",
	muted: "#8b93a1",
	faint: "#5d6573",
	accent: "#3fb6ad",
	accentSoft: "rgba(63,182,173,0.16)",
	onAccent: "#0b1614",
	danger: "#ef5b5b",
	dangerSoft: "rgba(239,91,91,0.14)",
	warning: "#e8b04a",
	warningSoft: "rgba(232,176,74,0.14)",
	ok: "#3fb950",
	code: "#0b0d10",
	codeText: "#c9ced6",
	userBubble: "#1f3b39",
	add: "#7ee2a8",
	del: "#ff9b94",
};

const light: Palette = {
	bg: "#f6f7f9",
	card: "#ffffff",
	elevated: "#eef0f3",
	border: "#dde1e6",
	text: "#16191d",
	muted: "#5f6773",
	faint: "#9aa1ab",
	accent: "#1f8f87",
	accentSoft: "rgba(31,143,135,0.12)",
	onAccent: "#ffffff",
	danger: "#d43d3d",
	dangerSoft: "rgba(212,61,61,0.10)",
	warning: "#b7791f",
	warningSoft: "rgba(183,121,31,0.12)",
	ok: "#2da44e",
	code: "#f0f2f5",
	codeText: "#24292f",
	userBubble: "#dff3f1",
	add: "#1a7f37",
	del: "#cf222e",
};

export function usePalette(): Palette {
	return useColorScheme() === "light" ? light : dark;
}

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });
