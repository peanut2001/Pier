import { Platform, useColorScheme } from "react-native";
import { useThemePreference } from "./theme-preference.ts";

export interface Palette {
	/** Whether this is the dark palette, for colors derived on the fly. */
	dark: boolean;
	bg: string;
	card: string;
	elevated: string;
	border: string;
	text: string;
	muted: string;
	faint: string;
	accent: string;
	accentText: string;
	accentSoft: string;
	accentRing: string;
	onAccent: string;
	danger: string;
	dangerSoft: string;
	warning: string;
	warningSoft: string;
	ok: string;
	okSoft: string;
	code: string;
	codeText: string;
	userBubble: string;
	add: string;
	del: string;
	/** Dimmed backdrop behind sheets. */
	scrim: string;
}

const dark: Palette = {
	dark: true,
	bg: "#08090c",
	card: "#0f1014",
	elevated: "#15161b",
	border: "rgba(255,255,255,0.11)",
	text: "#ededf0",
	muted: "#9a9ca8",
	faint: "#62646f",
	accent: "#2ab5aa",
	accentText: "#5fd6cb",
	accentSoft: "rgba(42,181,170,0.13)",
	accentRing: "rgba(42,181,170,0.45)",
	onAccent: "#071f1c",
	danger: "#f06464",
	dangerSoft: "rgba(240,100,100,0.12)",
	warning: "#e9b44c",
	warningSoft: "rgba(233,180,76,0.12)",
	ok: "#3fb96f",
	okSoft: "rgba(63,185,111,0.13)",
	code: "#0a0b0e",
	codeText: "#d9dce3",
	userBubble: "#1d2027",
	add: "#7ee2a8",
	del: "#ff9b94",
	scrim: "rgba(0,0,0,0.6)",
};

const light: Palette = {
	dark: false,
	bg: "#eef0f4",
	card: "#ffffff",
	elevated: "#f7f8fa",
	border: "rgba(15,23,42,0.13)",
	text: "#13161c",
	muted: "#5a6170",
	faint: "#9aa0ac",
	accent: "#11968c",
	accentText: "#0d7f77",
	accentSoft: "rgba(17,150,140,0.10)",
	accentRing: "rgba(17,150,140,0.4)",
	onAccent: "#ffffff",
	danger: "#d93b3b",
	dangerSoft: "rgba(217,59,59,0.08)",
	warning: "#b7791f",
	warningSoft: "rgba(214,158,46,0.12)",
	ok: "#1f9d55",
	okSoft: "rgba(31,157,85,0.10)",
	code: "#0f1116",
	codeText: "#d9dce3",
	userBubble: "#f0f2f6",
	add: "#7ee2a8",
	del: "#ff9b94",
	scrim: "rgba(10,14,20,0.42)",
};

export function usePalette(): Palette {
	const preference = useThemePreference();
	const system = useColorScheme();
	return (preference === "system" ? system : preference) === "light" ? light : dark;
}

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export const RADIUS = { sm: 7, md: 11, lg: 16, xl: 22, pill: 999 } as const;

/** Keep list and settings content readable on tablets and the web preview. */
export const PAGE = { width: "100%", maxWidth: 800, alignSelf: "center" } as const;

/** Thinking-level labels use the same purple as the desktop, in both palettes. */
export const THINKING_COLOR = "#8b5cf6";

/** Soft, layered card elevation (React Native's `boxShadow` works on every platform). */
export const SHADOW: object = { boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 6px 20px rgba(16,24,40,0.06)" };

/** Stronger elevation for floating surfaces such as the composer and toasts. */
export const FLOAT_SHADOW: object = { boxShadow: "0 2px 6px rgba(16,24,40,0.06), 0 12px 32px rgba(16,24,40,0.12)" };

/** Hues for name-derived tiles (hosts, workspaces, agents). */
const HUES = [172, 212, 256, 28, 332, 142, 196, 290];

function hash(text: string): number {
	let h = 0;
	for (const ch of text) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
	return h;
}

/** A stable, soft color pair for an icon tile, derived from a name. */
export function tileColors(p: Palette, name: string): { bg: string; fg: string } {
	const hue = HUES[hash(name.trim().toLowerCase()) % HUES.length] ?? HUES[0];
	return p.dark
		? { bg: `hsla(${hue}, 70%, 60%, 0.16)`, fg: `hsl(${hue}, 72%, 72%)` }
		: { bg: `hsla(${hue}, 72%, 46%, 0.12)`, fg: `hsl(${hue}, 64%, 36%)` };
}
