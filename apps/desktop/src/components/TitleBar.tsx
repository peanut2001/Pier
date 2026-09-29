import { useEffect, useState } from "react";
import { isTauri } from "../lib/bridge.ts";

/**
 * Windows draws the window undecorated (`tauri.windows.conf.json`), so the app supplies its own
 * title bar: an empty drag strip that blends into the window background, plus the caption
 * buttons. macOS and Linux keep their native title bars.
 */
export const customTitleBar = isTauri && typeof navigator !== "undefined" && /Windows/.test(navigator.userAgent);

type AppWindow = import("@tauri-apps/api/window").Window;

const currentWindow: Promise<AppWindow> | null = customTitleBar
	? import("@tauri-apps/api/window").then((m) => m.getCurrentWindow())
	: null;

function withWindow(action: (window: AppWindow) => Promise<unknown>) {
	void currentWindow?.then(action).catch(() => {});
}

/** Segoe Fluent-style caption glyphs, drawn at 10px like the native ones. */
function Glyph({ kind }: { kind: "minimize" | "maximize" | "restore" | "close" }) {
	return (
		<svg
			width="10"
			height="10"
			viewBox="0 0 10 10"
			fill="none"
			stroke="currentColor"
			strokeWidth="1"
			aria-hidden="true"
		>
			{kind === "minimize" ? <path d="M0 5.5h10" /> : null}
			{kind === "maximize" ? <rect x="0.5" y="0.5" width="9" height="9" rx="1" /> : null}
			{kind === "restore" ? (
				<>
					<rect x="0.5" y="2.5" width="7" height="7" rx="1" />
					<path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" />
				</>
			) : null}
			{kind === "close" ? <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /> : null}
		</svg>
	);
}

export function TitleBar() {
	const [maximized, setMaximized] = useState(false);

	useEffect(() => {
		if (!currentWindow) return;
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void currentWindow.then(async (window) => {
			const sync = () =>
				window.isMaximized().then(
					(value) => !disposed && setMaximized(value),
					() => {},
				);
			await sync();
			const fn = await window.onResized(() => void sync());
			if (disposed) fn();
			else unlisten = fn;
		});
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, []);

	if (!customTitleBar) return null;
	return (
		<div className="titlebar" data-tauri-drag-region>
			<div className="titlebar-drag" data-tauri-drag-region />
			<div className="titlebar-controls">
				<button
					type="button"
					className="titlebar-button"
					title="最小化"
					tabIndex={-1}
					onClick={() => withWindow((w) => w.minimize())}
				>
					<Glyph kind="minimize" />
				</button>
				<button
					type="button"
					className="titlebar-button"
					title={maximized ? "向下还原" : "最大化"}
					tabIndex={-1}
					onClick={() => withWindow((w) => w.toggleMaximize())}
				>
					<Glyph kind={maximized ? "restore" : "maximize"} />
				</button>
				<button
					type="button"
					className="titlebar-button close"
					title="关闭"
					tabIndex={-1}
					onClick={() => withWindow((w) => w.close())}
				>
					<Glyph kind="close" />
				</button>
			</div>
		</div>
	);
}
