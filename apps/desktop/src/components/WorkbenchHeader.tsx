import type { WorkspaceInfo } from "@pier/protocol";
import { useStore } from "../lib/store.tsx";
import { BrowserButton } from "./BrowserPanel.tsx";
import { FilesPanelToggle } from "./FilesPanel.tsx";
import { IconChevronRight, IconFolder } from "./Icons.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { TerminalToggle } from "./TerminalPanel.tsx";

/** A shared, fixed-height toolbar keeps navigation separate from the page's scroll area. */
export function WorkbenchHeader({ workspace, title }: { workspace?: WorkspaceInfo | undefined; title: string }) {
	const store = useStore();
	return (
		<header className="workbench-header">
			<SidebarToggle />
			<div className="workbench-breadcrumb">
				{workspace ? (
					<>
						<button
							type="button"
							className="workbench-workspace"
							onClick={() => store.selectWorkspace(workspace.id)}
							title={workspace.path}
						>
							<IconFolder size={15} />
							<span>{workspace.name}</span>
						</button>
						<IconChevronRight size={12} />
					</>
				) : (
					<IconFolder size={15} />
				)}
				<span className="workbench-page">{title}</span>
			</div>
			{workspace ? (
				<nav className="workbench-tools" aria-label="工作区工具">
					<BrowserButton workspace={workspace} />
					<TerminalToggle workspace={workspace} />
					<FilesPanelToggle />
				</nav>
			) : null}
		</header>
	);
}
