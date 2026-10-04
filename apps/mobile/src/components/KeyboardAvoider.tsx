import { type ReactNode, useEffect, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, type StyleProp, View, type ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Height of the Android soft keyboard above the navigation bar, in dp (0 when hidden or off Android).
 *
 * React Native ≥ 0.81 always runs Android edge-to-edge, so `adjustResize` no longer shrinks the
 * window and the keyboard simply covers the bottom of the screen. React Native reports the IME
 * height minus the system-bar inset, and re-emits `keyboardDidShow` whenever it changes.
 */
export function useAndroidKeyboardHeight(): number {
	const [height, setHeight] = useState(0);
	useEffect(() => {
		if (Platform.OS !== "android") return;
		const show = Keyboard.addListener("keyboardDidShow", (e) => setHeight(Math.max(0, e.endCoordinates.height)));
		const hide = Keyboard.addListener("keyboardDidHide", () => setHeight(0));
		return () => {
			show.remove();
			hide.remove();
		};
	}, []);
	return height;
}

/**
 * Keeps its bottom edge above the soft keyboard. The view must extend to the bottom of the screen.
 *
 * - iOS: `KeyboardAvoidingView` padding; `topOffset` is the distance from the top of the screen
 *   (for example the navigation header).
 * - Android: bottom padding equal to the keyboard. When `contentInsetsBottom` is set, the children
 *   already pad the navigation bar, so the padding only covers the keyboard above it.
 */
export function KeyboardAvoider({
	children,
	style,
	topOffset = 0,
	contentInsetsBottom = false,
}: {
	children: ReactNode;
	style?: StyleProp<ViewStyle>;
	topOffset?: number;
	contentInsetsBottom?: boolean;
}) {
	const insets = useSafeAreaInsets();
	const keyboard = useAndroidKeyboardHeight();
	if (Platform.OS === "ios") {
		return (
			<KeyboardAvoidingView style={style} behavior="padding" keyboardVerticalOffset={topOffset}>
				{children}
			</KeyboardAvoidingView>
		);
	}
	const paddingBottom = keyboard > 0 ? keyboard + (contentInsetsBottom ? 0 : insets.bottom) : 0;
	return <View style={[style, paddingBottom ? { paddingBottom } : null]}>{children}</View>;
}
