import type { WorkspaceFileEntry } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import { workspaceDragEntries, workspaceDropEntries } from "../src/lib/file-drag.ts";

const file = (path: string): WorkspaceFileEntry => ({ path, name: path.split("/").at(-1) as string, kind: "file" });
const folder = (path: string): WorkspaceFileEntry => ({ ...file(path), kind: "directory" });
const entries = [folder("src"), file("src/a.ts"), file("src/b.ts"), file("notes.txt"), folder("target")];

describe("workspace file drags", () => {
	it("drags all selected rows when starting on a selected file", () => {
		const selected = new Set(["src/a.ts", "notes.txt"]);
		expect(workspaceDragEntries(entries, selected, entries[1]).map((entry) => entry.path)).toEqual([
			"src/a.ts",
			"notes.txt",
		]);
		expect([...selected]).toEqual(["src/a.ts", "notes.txt"]);
	});

	it("drags only the starting row when it is outside the selection", () => {
		expect(workspaceDragEntries(entries, new Set(["src/a.ts"]), entries[3])).toEqual([file("notes.txt")]);
	});

	it("moves a selected folder once, without moving its selected children separately", () => {
		expect(workspaceDragEntries(entries, new Set(["src", "src/a.ts", "src/b.ts"]), entries[1])).toEqual([
			folder("src"),
		]);
	});

	it("rejects special files while retaining symlink metadata for the native transfer", () => {
		const special: WorkspaceFileEntry = { ...file("socket"), kind: "other" };
		expect(workspaceDragEntries([entries[3], special], new Set(["notes.txt", "socket"]), entries[3])).toEqual([]);
		const link = { ...folder("link"), symlink: true };
		expect(workspaceDragEntries([link], new Set(), link)).toEqual([link]);
	});
});

describe("workspace file drop destinations", () => {
	const dragged = workspaceDragEntries(entries, new Set(["src", "notes.txt"]), entries[0]);

	it("allows a closed target folder and the workspace root", () => {
		expect(workspaceDropEntries(dragged, "target")).toEqual(dragged);
		expect(workspaceDropEntries([file("src/a.ts")], "")).toEqual([file("src/a.ts")]);
	});

	it.each(["src", "src/sub", "src/sub/deeper"])("rejects moving any selected folder into %s", (dir) => {
		expect(workspaceDropEntries(dragged, dir)).toEqual([]);
	});

	it("treats a similarly named sibling as a valid destination", () => {
		expect(workspaceDropEntries(dragged, "src-backup")).toEqual(dragged);
	});

	it("omits unchanged files in a mixed selection and rejects a whole batch staying in place", () => {
		const files = [file("src/a.ts"), file("notes.txt")];
		expect(workspaceDropEntries(files, "src")).toEqual([file("notes.txt")]);
		expect(workspaceDropEntries(files, "")).toEqual([file("src/a.ts")]);
		expect(workspaceDropEntries([files[0]], "src")).toEqual([]);
		expect(workspaceDropEntries(dragged, "")).toEqual([]);
	});
});
