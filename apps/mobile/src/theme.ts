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
	bg: "#0e1013",
	card: "#171a1f",
	elevated: "#20242b",
	border: "#262a31",
	text: "#eceef1",
	muted: "#959cab",
	faint: "#5f6674",
	accent: "#3fc1b6",
	accentSoft: "rgba(63,193,182,0.15)",
	onAccent: "#0b1614",
	danger: "#ef5b5b",
	dangerSoft: "rgba(239,91,91,0.14)",
	warning: "#e8b04a",
	warningSoft: "rgba(232,176,74,0.14)",
	ok: "#3fb950",
	code: "#0b0d10",
	codeText: "#c9ced6",
	userBubble: "#1d3634",
	add: "#7ee2a8",
	del: "#ff9b94",
};

const light: Palette = {
	bg: "#f3f4f7",
	card: "#ffffff",
	elevated: "#eceef2",
	border: "#e3e6eb",
	text: "#14171b",
	muted: "#646c78",
	faint: "#a0a7b1",
	accent: "#14897f",
	accentSoft: "rgba(20,137,127,0.10)",
	onAccent: "#ffffff",
	danger: "#d43d3d",
	dangerSoft: "rgba(212,61,61,0.10)",
	warning: "#b7791f",
	warningSoft: "rgba(183,121,31,0.12)",
	ok: "#2da44e",
	code: "#f0f2f5",
	codeText: "#24292f",
	userBubble: "#dcf1ee",
	add: "#1a7f37",
	del: "#cf222e",
};

export function usePalette(): Palette {
	return useColorScheme() === "light" ? light : dark;
}

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export const RADIUS = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

/** Soft card elevation that reads well on both themes. */
export const SHADOW: object =
	Platform.select({
		ios: { shadowColor: "#000", shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
		android: { elevation: 1 },
		default: { boxShadow: "0 2px 10px rgba(0,0,0,0.06)" },
	}) ?? {};
