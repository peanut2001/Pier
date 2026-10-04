import { Platform, useColorScheme } from "react-native";

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
	accentSoft: string;
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
	bg: "#0a0c0f",
	card: "#14171c",
	elevated: "#1d2127",
	border: "#262b33",
	text: "#eef0f3",
	muted: "#9aa2ae",
	faint: "#626a77",
	accent: "#3ccfc0",
	accentSoft: "rgba(60,207,192,0.14)",
	onAccent: "#04201d",
	danger: "#f26b6b",
	dangerSoft: "rgba(242,107,107,0.14)",
	warning: "#eab54f",
	warningSoft: "rgba(234,181,79,0.14)",
	ok: "#46c35d",
	okSoft: "rgba(70,195,93,0.14)",
	code: "#0d1014",
	codeText: "#cdd3db",
	userBubble: "#173b37",
	add: "#7ee2a8",
	del: "#ff9b94",
	scrim: "rgba(0,0,0,0.6)",
};

const light: Palette = {
	dark: false,
	bg: "#f3f5f8",
	card: "#ffffff",
	elevated: "#edf0f4",
	border: "#e2e6ec",
	text: "#10141a",
	muted: "#5d6672",
	faint: "#99a1ad",
	accent: "#0f8a7e",
	accentSoft: "rgba(15,138,126,0.10)",
	onAccent: "#ffffff",
	danger: "#d63d3d",
	dangerSoft: "rgba(214,61,61,0.09)",
	warning: "#b7741a",
	warningSoft: "rgba(214,145,40,0.13)",
	ok: "#21a14a",
	okSoft: "rgba(33,161,74,0.11)",
	code: "#f2f4f7",
	codeText: "#24292f",
	userBubble: "#dff2ef",
	add: "#1a7f37",
	del: "#cf222e",
	scrim: "rgba(10,14,20,0.42)",
};

export function usePalette(): Palette {
	return useColorScheme() === "light" ? light : dark;
}

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" });

export const RADIUS = { sm: 8, md: 12, lg: 18, xl: 26, pill: 999 } as const;

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
