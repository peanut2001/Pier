import { useMemo } from "react";
import { MAX_DIFF_ROWS, parseGitDiff } from "../lib/git-diff.ts";

export function GitDiffView({ diff, truncated }: { diff: string; truncated?: boolean | undefined }) {
	const rows = useMemo(() => parseGitDiff(diff), [diff]);
	const shown = rows.length > MAX_DIFF_ROWS ? rows.slice(0, MAX_DIFF_ROWS) : rows;
	if (!rows.length) return <div className="file-viewer-empty">没有差异</div>;
	return (
		<div className="git-diff">
			{shown.map((row, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static diff rows.
				<div key={i} className={`git-diff-row ${row.kind}`}>
					<span className="git-diff-num">{row.oldLine ?? ""}</span>
					<span className="git-diff-num">{row.newLine ?? ""}</span>
					<span className="git-diff-mark">
						{row.kind === "add" ? "+" : row.kind === "del" ? "-" : row.kind === "ctx" ? " " : ""}
					</span>
					<span className="git-diff-text">{row.text || " "}</span>
				</div>
			))}
			{rows.length > MAX_DIFF_ROWS || truncated ? (
				<div className="git-diff-row meta">
					<span className="git-diff-num" />
					<span className="git-diff-num" />
					<span className="git-diff-mark" />
					<span className="git-diff-text">差异太长，只显示了开头部分</span>
				</div>
			) : null}
		</div>
	);
}
