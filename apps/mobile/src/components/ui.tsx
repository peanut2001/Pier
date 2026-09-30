import type { ReactNode } from "react";
import {
	ActivityIndicator,
	Alert,
	Platform,
	Pressable,
	type StyleProp,
	StyleSheet,
	Text,
	type TextStyle,
	View,
	type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileState, useStore } from "../store.ts";
import { type Palette, RADIUS, SHADOW, usePalette } from "../theme.ts";

/** Ask before a destructive action (`window.confirm` on web). */
export function confirmDestructive(title: string, message: string, action: string, onConfirm: () => void): void {
	if (Platform.OS === "web") {
		if (globalThis.confirm?.(`${title}\n\n${message}`)) onConfirm();
		return;
	}
	Alert.alert(title, message, [
		{ text: "取消", style: "cancel" },
		{ text: action, style: "destructive", onPress: onConfirm },
	]);
}

type Variant = "primary" | "secondary" | "tonal" | "danger" | "ghost";

function variantStyle(p: Palette, variant: Variant): { box: ViewStyle; text: TextStyle } {
	switch (variant) {
		case "primary":
			return { box: { backgroundColor: p.accent }, text: { color: p.onAccent } };
		case "tonal":
			return { box: { backgroundColor: p.accentSoft }, text: { color: p.accent } };
		case "danger":
			return { box: { backgroundColor: p.dangerSoft }, text: { color: p.danger } };
		case "ghost":
			return { box: { backgroundColor: "transparent" }, text: { color: p.accent } };
		default:
			return { box: { backgroundColor: p.elevated }, text: { color: p.text } };
	}
}

export function Button({
	title,
	onPress,
	variant = "secondary",
	disabled,
	loading,
	style,
	small,
	icon,
	testID,
}: {
	title: string;
	onPress: () => void;
	variant?: Variant;
	disabled?: boolean;
	loading?: boolean;
	style?: StyleProp<ViewStyle>;
	small?: boolean;
	/** Short glyph shown before the title, e.g. "+". */
	icon?: string;
	testID?: string;
}) {
	const p = usePalette();
	const v = variantStyle(p, variant);
	return (
		<Pressable
			testID={testID}
			accessibilityRole="button"
			accessibilityLabel={title}
			disabled={disabled || loading}
			onPress={onPress}
			style={({ pressed }) => [
				styles.button,
				small && styles.buttonSmall,
				v.box,
				(disabled || loading) && styles.disabled,
				pressed && styles.pressed,
				style,
			]}
		>
			{loading ? <ActivityIndicator size="small" color={v.text.color as string} style={styles.spinner} /> : null}
			{icon && !loading ? (
				<Text style={[styles.buttonIcon, small && styles.buttonIconSmall, v.text]}>{icon}</Text>
			) : null}
			<Text style={[styles.buttonText, small && styles.buttonTextSmall, v.text]}>{title}</Text>
		</Pressable>
	);
}

/** Compact text/glyph action for navigation headers. */
export function HeaderAction({ label, glyph, onPress }: { label: string; glyph?: string; onPress?: () => void }) {
	const p = usePalette();
	return (
		<Pressable
			hitSlop={8}
			onPress={onPress}
			accessibilityRole="button"
			accessibilityLabel={label}
			style={({ pressed }) => [
				glyph ? styles.headerIcon : styles.headerAction,
				{ backgroundColor: p.elevated },
				pressed && styles.pressed,
			]}
		>
			<Text style={[glyph ? styles.headerGlyph : styles.headerActionText, { color: p.text }]}>{glyph ?? label}</Text>
		</Pressable>
	);
}

export function Card({
	children,
	style,
	flat,
}: {
	children: ReactNode;
	style?: StyleProp<ViewStyle>;
	/** No shadow, e.g. for nested or banner cards. */
	flat?: boolean;
}) {
	const p = usePalette();
	return (
		<View style={[styles.card, !flat && SHADOW, { backgroundColor: p.card, borderColor: p.border }, style]}>
			{children}
		</View>
	);
}

export function StatusDot({ color, size = 8, ring }: { color: string; size?: number; ring?: string }) {
	return (
		<View
			style={{
				width: size,
				height: size,
				borderRadius: size / 2,
				backgroundColor: color,
				...(ring ? { borderWidth: 2, borderColor: ring } : {}),
			}}
		/>
	);
}

/** Rounded letter tile used as an icon for hosts and workspaces. */
export function Avatar({
	name,
	size = 40,
	tone = "accent",
	children,
}: {
	name: string;
	size?: number;
	tone?: "accent" | "muted";
	children?: ReactNode;
}) {
	const p = usePalette();
	const letter = Array.from(name.trim())[0]?.toUpperCase() ?? "?";
	return (
		<View
			style={{
				width: size,
				height: size,
				borderRadius: size * 0.32,
				alignItems: "center",
				justifyContent: "center",
				backgroundColor: tone === "accent" ? p.accentSoft : p.elevated,
			}}
		>
			<Text style={{ color: tone === "accent" ? p.accent : p.muted, fontSize: size * 0.42, fontWeight: "700" }}>
				{letter}
			</Text>
			{children}
		</View>
	);
}

export function Pill({
	text,
	tone = "muted",
	dot,
}: {
	text: string;
	tone?: "muted" | "accent" | "warning" | "danger";
	dot?: boolean;
}) {
	const p = usePalette();
	const colors = {
		muted: [p.elevated, p.muted],
		accent: [p.accentSoft, p.accent],
		warning: [p.warningSoft, p.warning],
		danger: [p.dangerSoft, p.danger],
	}[tone] as [string, string];
	return (
		<View style={[styles.pill, { backgroundColor: colors[0] }]}>
			{dot ? <StatusDot color={colors[1]} size={6} /> : null}
			<Text style={[styles.pillText, { color: colors[1] }]}>{text}</Text>
		</View>
	);
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	const p = usePalette();
	return <Text style={[styles.muted, { color: p.muted }, style]}>{children}</Text>;
}

export function Title({
	children,
	style,
	numberOfLines,
}: {
	children: ReactNode;
	style?: StyleProp<TextStyle>;
	numberOfLines?: number;
}) {
	const p = usePalette();
	return (
		<Text numberOfLines={numberOfLines} style={[styles.title, { color: p.text }, style]}>
			{children}
		</Text>
	);
}

/** Small uppercase-style label above a group of cards. */
export function SectionLabel({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	const p = usePalette();
	return <Text style={[styles.sectionLabel, { color: p.muted }, style]}>{children}</Text>;
}

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const p = usePalette();
	return <View style={[styles.screen, { backgroundColor: p.bg }, style]}>{children}</View>;
}

/** Transient message at the top of the screen. */
export function ToastHost() {
	const store = useStore();
	const toast = useMobileState((s) => s.toast);
	const p = usePalette();
	const insets = useSafeAreaInsets();
	if (!toast) return null;
	const error = toast.level === "error";
	return (
		<Pressable
			onPress={() => store.dismissToast()}
			style={[styles.toast, { top: insets.top + 60, backgroundColor: error ? p.danger : p.text }]}
		>
			<Text style={[styles.toastText, { color: error ? "#fff" : p.bg }]}>{toast.message}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1 },
	button: {
		minHeight: 46,
		paddingHorizontal: 18,
		borderRadius: RADIUS.md,
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "row",
		gap: 6,
	},
	buttonSmall: { minHeight: 34, paddingHorizontal: 14, borderRadius: RADIUS.pill },
	buttonText: { fontSize: 16, fontWeight: "600" },
	buttonTextSmall: { fontSize: 14 },
	buttonIcon: { fontSize: 18, fontWeight: "600", marginTop: -1 },
	buttonIconSmall: { fontSize: 16 },
	spinner: { marginRight: 2 },
	disabled: { opacity: 0.4 },
	pressed: { opacity: 0.65 },
	headerAction: { paddingHorizontal: 12, height: 32, borderRadius: RADIUS.pill, justifyContent: "center" },
	headerActionText: { fontSize: 14, fontWeight: "600" },
	headerIcon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
	headerGlyph: { fontSize: 18, fontWeight: "700", marginTop: -2 },
	card: { borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, padding: 16 },
	pill: {
		flexDirection: "row",
		alignItems: "center",
		gap: 5,
		paddingHorizontal: 9,
		paddingVertical: 3,
		borderRadius: RADIUS.pill,
		alignSelf: "flex-start",
	},
	pillText: { fontSize: 12, fontWeight: "600" },
	muted: { fontSize: 13, lineHeight: 19 },
	title: { fontSize: 17, fontWeight: "700" },
	sectionLabel: { fontSize: 13, fontWeight: "600", letterSpacing: 0.3, marginLeft: 4 },
	toast: {
		position: "absolute",
		alignSelf: "center",
		maxWidth: "90%",
		paddingHorizontal: 18,
		paddingVertical: 12,
		borderRadius: RADIUS.pill,
		...Platform.select({
			web: { boxShadow: "0 4px 14px rgba(0,0,0,0.2)" },
			default: {
				shadowColor: "#000",
				shadowOpacity: 0.2,
				shadowRadius: 14,
				shadowOffset: { width: 0, height: 4 },
				elevation: 8,
			},
		}),
	},
	toastText: { fontSize: 14, fontWeight: "500", textAlign: "center" },
});
