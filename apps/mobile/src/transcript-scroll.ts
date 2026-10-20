import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

type ScrollEvent = NativeSyntheticEvent<NativeScrollEvent>;

/** Follow layout changes until the reader deliberately scrolls away from the latest message. */
export function createTranscriptScroll(scrollToEnd: () => void) {
	let following = true;
	let interacting = false;
	let frame: number | undefined;
	let previous: { offset: number; content: number; viewport: number } | undefined;

	const onScroll = ({ nativeEvent }: ScrollEvent) => {
		const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
		const atBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
		// Web has no drag/momentum events: upward movement within unchanged geometry is reader input.
		const movedUp =
			previous &&
			contentSize.height === previous.content &&
			layoutMeasurement.height === previous.viewport &&
			contentOffset.y < previous.offset;
		// Native layout/scrollToEnd events can arrive before the new content has been positioned.
		// Only a user gesture may turn following off; reaching the bottom always turns it back on.
		if (interacting || movedUp || atBottom) following = atBottom;
		previous = { offset: contentOffset.y, content: contentSize.height, viewport: layoutMeasurement.height };
	};
	const follow = () => {
		if (!following || interacting || frame !== undefined) return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (following && !interacting) scrollToEnd();
		});
	};
	const begin = () => {
		interacting = true;
		following = false;
	};
	const end = (event: ScrollEvent) => {
		onScroll(event);
		interacting = false;
		follow();
	};

	return {
		props: {
			onScroll,
			onScrollBeginDrag: begin,
			onScrollEndDrag: end,
			onMomentumScrollBegin: begin,
			onMomentumScrollEnd: end,
			onLayout: follow,
			onContentSizeChange: follow,
		},
		dispose: () => {
			if (frame !== undefined) cancelAnimationFrame(frame);
			frame = undefined;
		},
	};
}
