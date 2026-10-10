import { thinkingLabel } from "@pier/chat-state";
import type { ThinkingLevel } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import {
	Animated,
	Easing,
	type GestureResponderEvent,
	PanResponder,
	Platform,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { THINKING_COLOR, usePalette } from "../theme.ts";
import { Icon } from "./ui.tsx";

/** Height of the track, which doubles as the fill (a progress bar with one stop per level). */
const TRACK = 24;
/** Inner padding of the track, so the thumb sits fully inside it at both ends. */
const PAD = TRACK / 2;
const THUMB = 26;
const DOT = 5;
/** A drag starts after the finger moved this far; anything less is a tap that picks a stop. */
const DRAG_SLOP = 3;
/** The desktop's long ease-out, so the thumb glides onto a stop and settles softly. */
const GLIDE = Easing.bezier(0.22, 1, 0.36, 1);
const EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
const FILL_GRADIENT = "linear-gradient(105deg, #3563e9, #7967ef 45%, #a76dff 72%, #5c6ded)";

/**
 * The thinking-level slider, the same as the desktop's: a pill-shaped track with one stop per
 * level the model supports, filled up to a round thumb. A tap picks the nearest stop and the thumb
 * glides there; a drag makes the thumb follow the finger, and on release it glides to the nearest
 * stop. The pick shows right away instead of waiting for the host to confirm it.
 */
export function ThinkingSlider({
	levels,
	value,
	onChange,
	onDragging,
}: {
	levels: ThinkingLevel[];
	value: ThinkingLevel;
	onChange: (level: ThinkingLevel) => unknown;
	/** Called when a touch starts and ends, so a surrounding scroll view can stand still. */
	onDragging?: (dragging: boolean) => void;
}) {
	const p = usePalette();
	const last = levels.length - 1;
	const rail = useRef<View>(null);
	const [width, setWidth] = useState(0);
	/** Where the thumb is (0–1) while it's being dragged. */
	const [drag, setDrag] = useState<number | undefined>();
	/** The stop just picked, shown until the change lands. */
	const [pending, setPending] = useState<number | undefined>();
	const settled = pending ?? Math.max(0, levels.indexOf(value));
	const index = drag !== undefined ? Math.round(drag * last) : settled;
	const at = drag ?? (last > 0 ? settled / last : 0);
	const label = thinkingLabel(levels[index] ?? value);

	const position = useRef(new Animated.Value(last > 0 ? settled / last : 0)).current;
	const scale = useRef(new Animated.Value(1)).current;
	const labelIn = useRef(new Animated.Value(1)).current;

	// Glide to the settled stop whenever it changes and nothing is being dragged.
	useEffect(() => {
		if (drag !== undefined) return;
		Animated.timing(position, {
			toValue: last > 0 ? settled / last : 0,
			duration: 300,
			easing: GLIDE,
			useNativeDriver: false,
		}).start();
	}, [drag, settled, last, position]);

	// The value label rises in whenever it changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: label only triggers the animation.
	useEffect(() => {
		labelIn.setValue(0);
		Animated.timing(labelIn, { toValue: 1, duration: 220, easing: EASE, useNativeDriver: true }).start();
	}, [label, labelIn]);

	const press = (pressed: boolean) =>
		Animated.timing(scale, {
			toValue: pressed ? 1.14 : 1,
			duration: 160,
			easing: EASE,
			useNativeDriver: false,
		}).start();

	// The gesture handlers are created once; they read the latest values through this ref.
	const latest = useRef({ levels, value, last, onChange, onDragging });
	latest.current = { levels, value, last, onChange, onDragging };
	const geometry = useRef({ left: 0, width: 0 });
	const touch = useRef<{ startX: number; dragging: boolean } | undefined>(undefined);
	const request = useRef(0);

	const commit = (next: number) => {
		const { levels, value, onChange } = latest.current;
		const level = levels[next];
		if (!level) return;
		const id = ++request.current;
		if (level === value) {
			setPending(undefined);
			return;
		}
		setPending(next);
		void Promise.resolve(onChange(level)).finally(() => {
			if (request.current === id) setPending(undefined);
		});
	};
	const commitRef = useRef(commit);
	commitRef.current = commit;

	const ratioAt = (pageX: number) => {
		const { left, width } = geometry.current;
		if (width <= 0) return 0;
		return Math.min(1, Math.max(0, (pageX - left) / width));
	};
	const measure = () =>
		rail.current?.measure((_x, _y, w, _h, left) => {
			geometry.current.left = left;
			geometry.current.width = w;
		});

	const end = (pageX: number | undefined) => {
		const current = touch.current;
		touch.current = undefined;
		press(false);
		if (current && pageX !== undefined) commitRef.current(Math.round(ratioAt(pageX) * latest.current.last));
		setDrag(undefined);
		latest.current.onDragging?.(false);
	};

	const responder = useRef(
		PanResponder.create({
			onStartShouldSetPanResponder: () => true,
			onMoveShouldSetPanResponder: () => true,
			// Keep the gesture once it started, even if it drifts vertically.
			onPanResponderTerminationRequest: () => false,
			onShouldBlockNativeResponder: () => true,
			onPanResponderGrant: (e: GestureResponderEvent) => {
				touch.current = { startX: e.nativeEvent.pageX, dragging: false };
				latest.current.onDragging?.(true);
				press(true);
				// Measure now: the sheet may have moved since the last layout.
				measure();
			},
			onPanResponderMove: (e) => {
				const current = touch.current;
				if (!current) return;
				const pageX = e.nativeEvent.pageX;
				// A tap just picks a stop; only a real drag makes the thumb follow the finger.
				if (!current.dragging && Math.abs(pageX - current.startX) < DRAG_SLOP) return;
				current.dragging = true;
				const ratio = ratioAt(pageX);
				position.setValue(ratio);
				setDrag(ratio);
			},
			onPanResponderRelease: (e) => end(e.nativeEvent.pageX),
			onPanResponderTerminate: () => end(undefined),
		}),
	).current;

	const step = (delta: number) => commit(Math.min(last, Math.max(0, settled + delta)));
	const fill = position.interpolate({ inputRange: [0, 1], outputRange: [TRACK, Math.max(0, width) + TRACK] });
	const thumbX = position.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(0, width)] });
	const trackColor = p.dark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.07)";

	return (
		<View style={styles.panel}>
			<View style={styles.head}>
				<View style={styles.title}>
					<Icon name="bulb-outline" size={14} color={p.muted} />
					<Text style={[styles.titleText, { color: p.muted }]}>思考程度</Text>
				</View>
				<Animated.Text
					style={[
						styles.value,
						{
							color: THINKING_COLOR,
							opacity: labelIn,
							transform: [{ translateY: labelIn.interpolate({ inputRange: [0, 1], outputRange: [5, 0] }) }],
						},
					]}
				>
					{label}
				</Animated.Text>
			</View>
			<View
				style={styles.touch}
				accessible
				accessibilityRole="adjustable"
				accessibilityLabel="思考程度"
				accessibilityValue={{ min: 0, max: last, now: index, text: label }}
				accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
				onAccessibilityAction={(e) => step(e.nativeEvent.actionName === "increment" ? 1 : -1)}
				{...responder.panHandlers}
			>
				<View style={[styles.track, { backgroundColor: trackColor }]} pointerEvents="none">
					<Animated.View style={[styles.fill, { width: fill }]} />
					<View
						ref={rail}
						style={styles.rail}
						onLayout={(e) => {
							setWidth(e.nativeEvent.layout.width);
							measure();
						}}
					>
						{levels.map((level, i) => {
							const stop = last > 0 ? i / last : 0;
							const passed = last > 0 && stop <= at + 1e-6;
							return (
								<View
									key={level}
									style={[
										styles.dot,
										{
											left: stop * width - DOT / 2,
											backgroundColor: passed ? "#fff" : p.faint,
											opacity: passed ? 0.75 : 0.7,
										},
									]}
								/>
							);
						})}
						<Animated.View style={[styles.thumb, { transform: [{ translateX: thumbX }, { scale }] }]} />
					</View>
				</View>
			</View>
			<View style={styles.scale}>
				<Text style={[styles.scaleText, { color: p.faint }]}>更快</Text>
				<Text style={[styles.scaleText, { color: p.faint }]}>更深入</Text>
			</View>
		</View>
	);
}

const styles = StyleSheet.create({
	panel: { paddingTop: 2 },
	head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: 6 },
	title: { flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "center" },
	titleText: { fontSize: 13, fontWeight: "500" },
	value: { fontSize: 16, fontWeight: "700" },
	// A taller touch target around the track.
	touch: { paddingVertical: 8 },
	track: { height: TRACK, borderRadius: TRACK / 2, paddingHorizontal: PAD },
	fill: {
		position: "absolute",
		top: 0,
		bottom: 0,
		left: 0,
		borderRadius: TRACK / 2,
		backgroundColor: "#7967ef",
		// React Native and React Native Web expose gradients under different style names.
		...Platform.select({
			web: { backgroundImage: FILL_GRADIENT },
			default: { experimental_backgroundImage: FILL_GRADIENT },
		}),
	},
	rail: { flex: 1 },
	dot: { position: "absolute", top: (TRACK - DOT) / 2, width: DOT, height: DOT, borderRadius: DOT / 2 },
	thumb: {
		position: "absolute",
		top: (TRACK - THUMB) / 2,
		left: -THUMB / 2,
		width: THUMB,
		height: THUMB,
		borderRadius: THUMB / 2,
		backgroundColor: "#fff",
		boxShadow: "0 1px 4px rgba(0,0,0,0.28), 0 0 0 1px rgba(0,0,0,0.06)",
	},
	scale: { flexDirection: "row", justifyContent: "space-between", marginTop: 2 },
	scaleText: { fontSize: 11.5 },
});
