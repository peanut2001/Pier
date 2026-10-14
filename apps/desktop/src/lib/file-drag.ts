import type { WorkspaceFileEntry } from "@pier/protocol";
import type { WorkspaceClipboardEntry } from "./workspace-clipboard.ts";

/** Internal drags carry a marker; the owning panel keeps the actual entries in memory. */
export const WORKSPACE_FILE_DRAG_TYPE = "application/x-pier-workspace-files";

/** Dragging a selected row moves the selection, with descendants covered by their parents. */
export function workspaceDragEntries(
	visible: readonly WorkspaceFileEntry[],
	selected: ReadonlySet<string>,
	entry: WorkspaceFileEntry,
): WorkspaceClipboardEntry[] {
	const entries = selected.has(entry.path) ? visible.filter((item) => selected.has(item.path)) : [entry];
	const roots = entries.filter(
		(item) => !entries.some((parent) => parent.kind === "directory" && item.path.startsWith(`${parent.path}/`)),
	);
	if (roots.some((item) => item.kind === "other")) return [];
	return roots.map(({ path, name, kind, symlink }) => ({
		path,
		name,
		kind: kind as WorkspaceClipboardEntry["kind"],
		...(symlink ? { symlink } : {}),
	}));
}

/** Reject self/descendant targets and omit entries already in the destination directory. */
export function workspaceDropEntries(
	entries: readonly WorkspaceClipboardEntry[],
	dir: string,
): WorkspaceClipboardEntry[] {
	if (entries.some((entry) => dir === entry.path || dir.startsWith(`${entry.path}/`))) return [];
	return entries.filter((entry) => {
		const slash = entry.path.lastIndexOf("/");
		return (slash < 0 ? "" : entry.path.slice(0, slash)) !== dir;
	});
}
