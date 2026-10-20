import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptScroll } from "../src/transcript-scroll.ts";

let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
	frames = new Map();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		frames.set(++nextFrame, callback);
		return nextFrame;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => vi.unstubAllGlobals());

function flushLayout() {
	const pending = [...frames.values()];
	frames.clear();
	for (const callback of pending) callback(0);
}

function transcript(height = 100) {
	const viewport = { height: 600, content: height, offset: 0 };
	const scrollToEnd = vi.fn(() => {
		viewport.offset = Math.max(0, viewport.content - viewport.height);
	});
	const scroll = createTranscriptScroll(scrollToEnd);
	const event = () =>
		({
			nativeEvent: {
				contentOffset: { y: viewport.offset },
				contentSize: { height: viewport.content },
				layoutMeasurement: { height: viewport.height },
			},
		}) as Parameters<typeof scroll.props.onScroll>[0];
	return { viewport, scroll, scrollToEnd, event };
}

describe("mobile transcript scrolling", () => {
	it.each([true, false])("opens at the bottom when a stale scroll arrives before content-size change: %s", (first) => {
		const { viewport, scroll, event } = transcript();
		scroll.props.onLayout();
		flushLayout();

		viewport.content = 8000;
		if (first) scroll.props.onScroll(event());
		scroll.props.onContentSizeChange();
		if (!first) scroll.props.onScroll(event());
		flushLayout();

		expect(viewport.offset).toBe(7400);
	});

	it("follows cached history and later content growth after layout", () => {
		const { viewport, scroll, event } = transcript(8000);
		scroll.props.onScroll(event());
		scroll.props.onLayout();
		scroll.props.onContentSizeChange();
		flushLayout();
		expect(viewport.offset).toBe(7400);

		viewport.content = 12000;
		scroll.props.onScroll(event());
		scroll.props.onContentSizeChange();
		flushLayout();
		expect(viewport.offset).toBe(11400);
	});

	it("keeps the latest message visible when the keyboard shrinks the viewport", () => {
		const { viewport, scroll, event } = transcript(8000);
		scroll.props.onContentSizeChange();
		flushLayout();

		viewport.height = 300;
		scroll.props.onScroll(event());
		scroll.props.onLayout();
		flushLayout();
		expect(viewport.offset).toBe(7700);
	});

	it("cancels a queued follow when the reader starts dragging and preserves their history position", () => {
		const { viewport, scroll, event, scrollToEnd } = transcript(8000);
		scroll.props.onContentSizeChange();
		scroll.props.onScrollBeginDrag();
		viewport.offset = 1200;
		scroll.props.onScroll(event());
		scroll.props.onScrollEndDrag(event());
		flushLayout();
		expect(scrollToEnd).not.toHaveBeenCalled();

		viewport.content = 12000;
		scroll.props.onScroll(event());
		scroll.props.onContentSizeChange();
		scroll.props.onLayout();
		flushLayout();
		expect(viewport.offset).toBe(1200);
	});

	it("waits for momentum to finish and resumes following when the reader returns to the bottom", () => {
		const { viewport, scroll, event, scrollToEnd } = transcript(8000);
		scroll.props.onScrollBeginDrag();
		viewport.offset = 6000;
		scroll.props.onScrollEndDrag(event());
		scroll.props.onMomentumScrollBegin();
		viewport.offset = 7400;
		scroll.props.onScroll(event());
		scroll.props.onContentSizeChange();
		flushLayout();
		expect(scrollToEnd).not.toHaveBeenCalled();
		scroll.props.onMomentumScrollEnd(event());
		flushLayout();

		viewport.content = 10000;
		scroll.props.onScroll(event());
		scroll.props.onContentSizeChange();
		flushLayout();
		expect(viewport.offset).toBe(9400);
	});

	it("preserves history for web scrolling without native drag events and resumes at the bottom", () => {
		const { viewport, scroll, event } = transcript(8000);
		scroll.props.onContentSizeChange();
		flushLayout();
		// React Native Web's event offsets are getters reading the live DOM node.
		const webEvent = event();
		Object.defineProperty(webEvent.nativeEvent.contentOffset, "y", { get: () => viewport.offset });
		scroll.props.onScroll(webEvent);
		viewport.offset = 1200;
		scroll.props.onScroll(event());
		viewport.content = 12000;
		scroll.props.onContentSizeChange();
		flushLayout();
		expect(viewport.offset).toBe(1200);

		viewport.offset = 11400;
		scroll.props.onScroll(event());
		viewport.content = 13000;
		scroll.props.onContentSizeChange();
		flushLayout();
		expect(viewport.offset).toBe(12400);
	});

	it("cancels pending work when leaving and starts a different session at its latest message", () => {
		const previous = transcript(8000);
		previous.scroll.props.onContentSizeChange();
		previous.scroll.dispose();
		const next = transcript(4000);
		next.scroll.props.onLayout();
		flushLayout();
		expect(previous.scrollToEnd).not.toHaveBeenCalled();
		expect(next.viewport.offset).toBe(3400);
	});
});
