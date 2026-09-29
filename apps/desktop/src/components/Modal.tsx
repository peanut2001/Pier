import type { ReactNode } from "react";
import { IconX } from "./Icons.tsx";

/**
 * A dialog that closes only through an explicit control (the header close button or the
 * dialog's own buttons). Clicking the backdrop and pressing Esc deliberately do nothing, so a
 * stray click or an IME-cancelling Esc cannot throw away a half-filled form.
 */
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
	return (
		<div className="modal-backdrop">
			<div className={`modal${wide ? " wide" : ""}${className ? ` ${className}` : ""}`}>
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
