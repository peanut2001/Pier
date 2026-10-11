import {
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";

const MARGIN = 8;
const GAP = 6;
const MAX_HEIGHT = 440;

interface Placement {
	left: number;
	top?: number;
	bottom?: number;
	maxHeight: number;
}

/** A menu anchored to a trigger, rendered above clipping containers in a body portal. */
export function AnchoredMenu({
	anchor,
	children,
	onClose,
	className,
	label,
	align = "end",
}: {
	anchor: RefObject<HTMLElement | null>;
	children: ReactNode;
	onClose(): void;
	className?: string;
	label?: string;
	align?: "start" | "end";
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<Placement>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useLayoutEffect(() => {
		const menu = menuRef.current;
		const trigger = anchor.current;
		if (!menu || !trigger) return;

		const update = () => {
			const rect = trigger.getBoundingClientRect();
			const { width, height } = menu.getBoundingClientRect();
			const below = Math.max(0, window.innerHeight - rect.bottom - GAP - MARGIN);
			const above = Math.max(0, rect.top - GAP - MARGIN);
			const up = height > below && above > below;
			const preferredLeft = align === "end" ? rect.right - width : rect.left;
			const left = Math.max(MARGIN, Math.min(preferredLeft, window.innerWidth - MARGIN - width));
			setPlaced({
				left,
				...(up ? { bottom: window.innerHeight - rect.top + GAP } : { top: rect.bottom + GAP }),
				maxHeight: Math.min(MAX_HEIGHT, up ? above : below),
			});
		};

		update();
		const resizeObserver = new ResizeObserver(update);
		resizeObserver.observe(trigger);
		// The trigger's position changes while the resizable sidebar is being dragged even though
		// its own dimensions stay the same, so observe its layout container as well.
		if (trigger.parentElement) resizeObserver.observe(trigger.parentElement);
		window.addEventListener("resize", update);
		document.addEventListener("scroll", update, true);
		return () => {
			resizeObserver.disconnect();
			window.removeEventListener("resize", update);
			document.removeEventListener("scroll", update, true);
		};
	}, [align, anchor]);

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const close = () => onCloseRef.current();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node;
			if (menuRef.current?.contains(target) || anchor.current?.contains(target)) return;
			close();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("keydown", onKey, true);
		window.addEventListener("blur", close);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("keydown", onKey, true);
			window.removeEventListener("blur", close);
			if (previous?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
				previous.focus({ preventScroll: true });
			}
		};
	}, [anchor]);

	useEffect(() => {
		if (placed)
			menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
	}, [placed]);

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
		const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
		const move = (next: number) => buttons[(next + buttons.length) % buttons.length]?.focus();
		if (event.key === "ArrowDown") move(index + 1);
		else if (event.key === "ArrowUp") move(index < 0 ? -1 : index - 1);
		else if (event.key === "Home") move(0);
		else if (event.key === "End") move(-1);
		else if (event.key === "Tab") {
			event.preventDefault();
			onCloseRef.current();
			return;
		} else return;
		event.preventDefault();
		event.stopPropagation();
	};

	return createPortal(
		<div
			ref={menuRef}
			className={`dropdown-menu anchored-menu${className ? ` ${className}` : ""}`}
			role="menu"
			aria-label={label}
			tabIndex={-1}
			style={
				placed
					? {
							left: placed.left,
							right: "auto",
							top: placed.top,
							bottom: placed.bottom,
							maxHeight: placed.maxHeight,
						}
					: { visibility: "hidden", left: 0, right: "auto", top: 0 }
			}
			onKeyDown={onKeyDown}
		>
			{children}
		</div>,
		document.body,
	);
}
