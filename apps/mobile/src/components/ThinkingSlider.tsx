import { thinkingLabel } from "@pier/chat-state";
import type { ThinkingLevel } from "@pier/protocol";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, type GestureResponderEvent, PanResponder, StyleSheet, Text, View } from "react-native";
import { usePalette } from "../theme.ts";

const THUMB = 24;
const TRACK = 6;
const DOT = 6;

/**
 * The thinking-level slider, like the desktop's: a track with one stop per level the model
 * supports. The thumb follows the finger while dragging and glides to the nearest stop on
 * release (a tap picks the nearest stop); the pick shows right away instead of waiting for the
 * host to confirm it.
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
	/** Called when a drag starts and ends, so a surrounding scroll view can stand still. */
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
	const label = thinkingLabel(levels[index] ?? value);
	const position = useRef(new Animated.Value(last > 0 ? settled / last : 0)).current;

	// Glide to the settled stop whenever it changes and nothing is being dragged.
	useEffect(() => {
		if (drag !== undefined) return;
		Animated.timing(position, {
			toValue: last > 0 ? settled / last : 0,
			duration: 180,
			easing: Easing.out(Easing.cubic),
			useNativeDriver: false,
		}).start();
	}, [drag, settled, last, position]);

	// The gesture handlers are created once; they read the latest values through this ref.
	const latest = useRef({ levels, value, last, onChange, onDragging });
	latest.current = { levels, value, last, onChange, onDragging };
	const geometry = useRef({ left: 0, width: 0, active: false });
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

	const responder = useRef(
		PanResponder.create({
			onStartShouldSetPanResponder: () => true,
			onMoveShouldSetPanResponder: () => true,
			// Keep the gesture once it started, even if it drifts vertically.
			onPanResponderTerminationRequest: () => false,
			onShouldBlockNativeResponder: () => true,
			onPanResponderGrant: (e: GestureResponderEvent) => {
				const pageX = e.nativeEvent.pageX;
				geometry.current.active = true;
				latest.current.onDragging?.(true);
				const ratio = ratioAt(pageX);
				position.stopAnimation();
				position.setValue(ratio);
				setDrag(ratio);
				// Measure now: the sheet may have moved since the last layout.
				rail.current?.measure((_x, _y, w, _h, left) => {
					geometry.current.left = left;
					geometry.current.width = w;
					if (!geometry.current.active) return;
					const ratio = ratioAt(pageX);
					position.setValue(ratio);
					setDrag(ratio);
				});
			},
			onPanResponderMove: (e) => {
				const ratio = ratioAt(e.nativeEvent.pageX);
				position.setValue(ratio);
				setDrag(ratio);
			},
			onPanResponderRelease: (e) => {
				const ratio = ratioAt(e.nativeEvent.pageX);
				const { last } = latest.current;
				const next = Math.round(ratio * last);
				// Commit before the drag ends, so the thumb glides straight to the picked stop.
				geometry.current.active = false;
				commitRef.current(next);
				setDrag(undefined);
				latest.current.onDragging?.(false);
			},
			onPanResponderTerminate: () => {
				geometry.current.active = false;
				setDrag(undefined);
				latest.current.onDragging?.(false);
			},
		}),
	).current;

	const step = (delta: number) => commit(Math.min(last, Math.max(0, settled + delta)));
	const left = position.interpolate({ inputRange: [0, 1], outputRange: [0, Math.max(0, width)] });

	return (
		<View style={styles.panel}>
			<View style={styles.head}>
				<Text style={[styles.title, { color: p.text }]}>思考程度</Text>
				<Text style={[styles.value, { color: p.accent }]}>{label}</Text>
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
				<View
					ref={rail}
					style={styles.rail}
					onLayout={(e) => {
						setWidth(e.nativeEvent.layout.width);
						rail.current?.measure((_x, _y, w, _h, left) => {
							geometry.current.left = left;
							geometry.current.width = w;
						});
					}}
					pointerEvents="none"
				>
					<View style={[styles.track, { backgroundColor: p.border }]} />
					<Animated.View style={[styles.fill, { backgroundColor: p.accent, width: left }]} />
					{levels.map((level, i) => {
						const at = last > 0 ? i / last : 0;
						const passed = at <= (drag ?? (last > 0 ? settled / last : 0)) + 1e-6;
						return (
							<View
								key={level}
								style={[styles.dot, { left: at * width - DOT / 2, backgroundColor: passed ? p.onAccent : p.faint }]}
							/>
						);
					})}
					<Animated.View
						style={[
							styles.thumb,
							{
								backgroundColor: p.card,
								borderColor: p.accent,
								transform: [{ translateX: left }, { scale: drag !== undefined ? 1.15 : 1 }],
							},
						]}
					/>
				</View>
				<View style={styles.labels} pointerEvents="none">
					{levels.map((level, i) => (
						<Text
							key={level}
							numberOfLines={1}
							style={[
								styles.stopLabel,
								{ left: (last > 0 ? i / last : 0) * width - 22 },
								{ color: i === index ? p.accent : p.muted, fontWeight: i === index ? "700" : "500" },
							]}
						>
							{thinkingLabel(level)}
						</Text>
					))}
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
	panel: { gap: 4 },
	head: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
	title: { fontSize: 15, fontWeight: "600" },
	value: { fontSize: 15, fontWeight: "700" },
	touch: { paddingHorizontal: THUMB / 2 + 4, paddingTop: 12, paddingBottom: 4 },
	rail: { height: THUMB },
	track: { position: "absolute", top: (THUMB - TRACK) / 2, left: 0, right: 0, height: TRACK, borderRadius: TRACK / 2 },
	fill: { position: "absolute", top: (THUMB - TRACK) / 2, left: 0, height: TRACK, borderRadius: TRACK / 2 },
	dot: { position: "absolute", top: (THUMB - DOT) / 2, width: DOT, height: DOT, borderRadius: DOT / 2 },
	thumb: {
		position: "absolute",
		top: 0,
		left: -THUMB / 2,
		width: THUMB,
		height: THUMB,
		borderRadius: THUMB / 2,
		borderWidth: 3,
		shadowColor: "#000",
		shadowOpacity: 0.18,
		shadowRadius: 3,
		shadowOffset: { width: 0, height: 1 },
		elevation: 3,
	},
	labels: { height: 22, marginTop: 6 },
	stopLabel: { position: "absolute", width: 44, textAlign: "center", fontSize: 12 },
	scale: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 2 },
	scaleText: { fontSize: 11.5 },
});
