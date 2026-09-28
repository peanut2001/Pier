import type { ReactNode } from "react";

/** Building blocks shared by the settings pages: titled groups of cards made of rows. */

export function SettingsGroup({
	title,
	actions,
	children,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
}) {
	return (
		<section className="settings-group">
			{title || actions ? (
				<div className="settings-group-head">
					{title ? <h2>{title}</h2> : <span />}
					{actions ? <div className="settings-group-actions">{actions}</div> : null}
				</div>
			) : null}
			{children}
		</section>
	);
}

export function SettingsCard({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={`settings-card${className ? ` ${className}` : ""}`}>{children}</div>;
}

/** A label/description on the left and a control on the right (or below with `stack`). */
export function SettingRow({
	title,
	description,
	children,
	stack,
}: {
	title: ReactNode;
	description?: ReactNode;
	children?: ReactNode;
	stack?: boolean;
}) {
	return (
		<div className={`setting-row${stack ? " stack" : ""}`}>
			<div className="setting-text">
				<div className="setting-title">{title}</div>
				{description ? <div className="setting-desc">{description}</div> : null}
			</div>
			{children ? <div className="setting-control">{children}</div> : null}
		</div>
	);
}

export function Switch({
	checked,
	onChange,
	disabled,
	label,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	label: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			title={label}
			className={`switch${checked ? " on" : ""}`}
			disabled={disabled}
			onClick={() => onChange(!checked)}
		>
			<span className="switch-thumb" />
		</button>
	);
}
