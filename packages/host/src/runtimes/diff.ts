/**
 * Diffs in the form pi's `edit` tool reports them (`details.diff`), which clients render:
 * `+<line> text` for added lines, `-<line> text` for removed ones, ` <line> text` for context
 * and ` ...` between hunks.
 */

export interface DiffHunk {
	oldStart: number;
	newStart: number;
	/** Lines prefixed with `+`, `-` or ` ` (unified diff body). */
	lines: string[];
}

export function hunksToDiff(hunks: DiffHunk[]): string {
	const width = Math.max(1, ...hunks.map((h) => String(Math.max(h.oldStart, h.newStart) + h.lines.length).length));
	const output: string[] = [];
	for (const [index, hunk] of hunks.entries()) {
		if (index > 0) output.push(` ${"".padStart(width, " ")} ...`);
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			const mark = line[0];
			const text = line.slice(1);
			if (mark === "+") {
				output.push(`+${String(newLine).padStart(width, " ")} ${text}`);
				newLine++;
			} else if (mark === "-") {
				output.push(`-${String(oldLine).padStart(width, " ")} ${text}`);
				oldLine++;
			} else if (mark === "\\") {
				// "\ No newline at end of file"
			} else {
				output.push(` ${String(oldLine).padStart(width, " ")} ${text}`);
				oldLine++;
				newLine++;
			}
		}
	}
	return output.join("\n");
}

/** Parse the hunks of a unified diff (file headers are skipped). */
export function parseUnifiedDiff(diff: string): DiffHunk[] {
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | undefined;
	for (const line of diff.split("\n")) {
		const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
		if (header) {
			current = { oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
			hunks.push(current);
			continue;
		}
		if (!current) continue;
		if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
		if (line === "") continue;
		if (/^[+\- \\]/.test(line)) current.lines.push(line);
	}
	return hunks;
}

/** A diff that adds every line of `content` (a new file). */
export function additionDiff(content: string): string {
	const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
	return hunksToDiff([{ oldStart: 1, newStart: 1, lines: lines.map((l) => `+${l}`) }]);
}
