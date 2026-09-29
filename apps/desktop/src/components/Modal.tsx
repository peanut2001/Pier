import { type ReactNode, useEffect } from "react";
import { IconX } from "./Icons.tsx";

export function Modal({
	title,
	onClose,
	children,
	wide,
	className,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
	wide?: boolean;
	className?: string;
}) {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: clicking the backdrop closes the dialog; Esc also works.
		// biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled globally above.
		<div className="modal-backdrop" onClick={onClose}>
			{/* biome-ignore lint/a11y/useKeyWithClickEvents: only stops propagation. */}
			{/* biome-ignore lint/a11y/noStaticElementInteractions: only stops propagation. */}
			<div
				className={`modal${wide ? " wide" : ""}${className ? ` ${className}` : ""}`}
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-header">
					<h3>{title}</h3>
					<button type="button" className="ghost icon" onClick={onClose} title="关闭">
						<IconX size={16} />
					</button>
				</div>
				<div className="modal-body">{children}</div>
			</div>
		</div>
	);
}
