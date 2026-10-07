export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "file" | "meta";

export interface DiffRow {
	kind: DiffRowKind;
	text: string;
	oldLine?: number;
	newLine?: number;
}

/** Lines shown at most; longer diffs end with a note. */
export const MAX_DIFF_ROWS = 20_000;

/** The b/ side of a `diff --git a/x b/y` header (or the only path of `diff --cc x`). */
function headerPath(line: string): string {
	const cc = /^diff --(?:cc|combined) (.+)$/.exec(line);
	if (cc) return cc[1] as string;
	const git = /^diff --git (?:"?a\/.*?"? )?"?b\/(.+?)"?$/.exec(line);
	return git ? (git[1] as string) : line.slice(5);
}

/**
 * Turn `git diff` / `git show` output into display rows with line numbers. Commit headers and
 * file metadata become `meta` rows; `---`/`+++` and `index` lines are left out.
 */
export function parseGitDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	/** Parent columns of a combined (merge) diff; 0 outside hunks. */
	let columns = 0;
	let inHunk = false;
	const lines = diff.split("\n");
	if (lines.at(-1) === "") lines.pop();
	for (const line of lines) {
		if (line.startsWith("diff --")) {
			inHunk = false;
			rows.push({ kind: "file", text: headerPath(line) });
			continue;
		}
		const hunk = /^(@{2,}) -(\d+)(?:,\d+)?(?: -\d+(?:,\d+)?)* \+(\d+)(?:,\d+)? @{2,}(.*)$/.exec(line);
		if (hunk) {
			inHunk = true;
			columns = (hunk[1] as string).length - 1;
			oldLine = Number(hunk[2]);
			newLine = Number(hunk[3]);
			rows.push({ kind: "hunk", text: line });
			continue;
		}
		if (!inHunk) {
			if (/^(index |--- |\+\+\+ )/.test(line)) continue;
			rows.push({ kind: "meta", text: line });
			continue;
		}
		if (line.startsWith("\\")) {
			rows.push({ kind: "meta", text: line });
			continue;
		}
		const marks = line.slice(0, columns);
		const text = line.slice(columns);
		if (marks.includes("+")) {
			rows.push({ kind: "add", text, newLine: newLine++ });
		} else if (marks.includes("-")) {
			rows.push({ kind: "del", text, oldLine: oldLine++ });
		} else if (/^ *$/.test(marks) && (line.length > 0 || columns === 1)) {
			rows.push({ kind: "ctx", text, oldLine: oldLine++, newLine: newLine++ });
		} else {
			// Something after the last hunk (e.g. the next commit's header in `git show`).
			inHunk = false;
			rows.push({ kind: "meta", text: line });
		}
	}
	return rows;
}

/** Added and removed line counts of a diff. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const row of rows) {
		if (row.kind === "add") added++;
		else if (row.kind === "del") removed++;
	}
	return { added, removed };
}
