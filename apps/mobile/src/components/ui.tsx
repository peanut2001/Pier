import type { ReactNode } from "react";
import {
	ActivityIndicator,
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
import { type Palette, usePalette } from "../theme.ts";

type Variant = "primary" | "secondary" | "danger" | "ghost";

function variantStyle(p: Palette, variant: Variant): { box: ViewStyle; text: TextStyle } {
	switch (variant) {
		case "primary":
			return { box: { backgroundColor: p.accent }, text: { color: p.onAccent } };
		case "danger":
			return { box: { backgroundColor: p.dangerSoft }, text: { color: p.danger } };
		case "ghost":
			return { box: { backgroundColor: "transparent" }, text: { color: p.accent } };
		default:
			return { box: { backgroundColor: p.elevated, borderColor: p.border, borderWidth: 1 }, text: { color: p.text } };
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
	testID,
}: {
	title: string;
	onPress: () => void;
	variant?: Variant;
	disabled?: boolean;
	loading?: boolean;
	style?: StyleProp<ViewStyle>;
	small?: boolean;
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
			<Text style={[styles.buttonText, small && styles.buttonTextSmall, v.text]}>{title}</Text>
		</Pressable>
	);
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const p = usePalette();
	return <View style={[styles.card, { backgroundColor: p.card, borderColor: p.border }, style]}>{children}</View>;
}

export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
	return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export function Pill({ text, tone = "muted" }: { text: string; tone?: "muted" | "accent" | "warning" | "danger" }) {
	const p = usePalette();
	const colors = {
		muted: [p.elevated, p.muted],
		accent: [p.accentSoft, p.accent],
		warning: [p.warningSoft, p.warning],
		danger: [p.dangerSoft, p.danger],
	}[tone];
	return (
		<View style={[styles.pill, { backgroundColor: colors[0] }]}>
			<Text style={[styles.pillText, { color: colors[1] }]}>{text}</Text>
		</View>
	);
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	const p = usePalette();
	return <Text style={[styles.muted, { color: p.muted }, style]}>{children}</Text>;
}

export function Title({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
	const p = usePalette();
	return <Text style={[styles.title, { color: p.text }, style]}>{children}</Text>;
}

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
	const p = usePalette();
	return <View style={[styles.screen, { backgroundColor: p.bg }, style]}>{children}</View>;
}

/** Transient message at the bottom of the screen. */
export function ToastHost() {
	const store = useStore();
	const toast = useMobileState((s) => s.toast);
	const p = usePalette();
	const insets = useSafeAreaInsets();
	if (!toast) return null;
	return (
		<Pressable
			onPress={() => store.dismissToast()}
			style={[
				styles.toast,
				{
					top: insets.top + 64,
					backgroundColor: toast.level === "error" ? p.danger : p.elevated,
					borderColor: p.border,
				},
			]}
		>
			<Text style={{ color: toast.level === "error" ? "#fff" : p.text }}>{toast.message}</Text>
		</Pressable>
	);
}

const styles = StyleSheet.create({
	screen: { flex: 1 },
	button: {
		minHeight: 44,
		paddingHorizontal: 16,
		borderRadius: 10,
		alignItems: "center",
		justifyContent: "center",
		flexDirection: "row",
	},
	buttonSmall: { minHeight: 34, paddingHorizontal: 12, borderRadius: 8 },
	buttonText: { fontSize: 16, fontWeight: "600" },
	buttonTextSmall: { fontSize: 14 },
	spinner: { marginRight: 8 },
	disabled: { opacity: 0.45 },
	pressed: { opacity: 0.7 },
	card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
	pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, alignSelf: "flex-start" },
	pillText: { fontSize: 12, fontWeight: "600" },
	muted: { fontSize: 13, lineHeight: 18 },
	title: { fontSize: 17, fontWeight: "600" },
	toast: {
		position: "absolute",
		left: 16,
		right: 16,
		padding: 14,
		borderRadius: 12,
		borderWidth: StyleSheet.hairlineWidth,
		shadowColor: "#000",
		shadowOpacity: 0.25,
		shadowRadius: 12,
		elevation: 6,
	},
});
