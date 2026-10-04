import { memo, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { MONO, type Palette, usePalette } from "../theme.ts";

/**
 * Deliberately small Markdown renderer for chat text: fenced code blocks, headings,
 * list bullets, blockquotes, and inline `code` / **bold**. Everything else stays plain
 * (selectable) text, which is robust while streaming.
 */

type Block =
	| { kind: "code"; lang: string; text: string }
	| { kind: "heading"; level: number; text: string }
	| { kind: "quote"; text: string }
	| { kind: "list"; bullet: string; text: string; indent: number }
	| { kind: "para"; text: string };

function parseBlocks(source: string): Block[] {
	const blocks: Block[] = [];
	const lines = source.split("\n");
	let para: string[] = [];
	const flush = () => {
		if (para.length) blocks.push({ kind: "para", text: para.join("\n") });
		para = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		const fence = /^\s*(```|~~~)(.*)$/.exec(line);
		if (fence) {
			flush();
			const marker = fence[1] ?? "```";
			const body: string[] = [];
			i++;
			while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker)) {
				body.push(lines[i] ?? "");
				i++;
			}
			blocks.push({ kind: "code", lang: (fence[2] ?? "").trim(), text: body.join("\n") });
			continue;
		}
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			flush();
			blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, text: heading[2] ?? "" });
			continue;
		}
		const list = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (list) {
			flush();
			const bullet = /\d/.test(list[2] ?? "") ? (list[2] ?? "") : "•";
			blocks.push({
				kind: "list",
				bullet,
				text: list[3] ?? "",
				indent: Math.min(3, Math.floor((list[1]?.length ?? 0) / 2)),
			});
			continue;
		}
		const quote = /^>\s?(.*)$/.exec(line);
		if (quote) {
			flush();
			blocks.push({ kind: "quote", text: quote[1] ?? "" });
			continue;
		}
		if (!line.trim()) {
			flush();
			continue;
		}
		para.push(line);
	}
	flush();
	return blocks;
}

function inline(text: string, p: Palette, key: string): ReactNode[] {
	const parts: ReactNode[] = [];
	const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
	let last = 0;
	let match: RegExpExecArray | null = pattern.exec(text);
	let n = 0;
	while (match) {
		if (match.index > last) parts.push(text.slice(last, match.index));
		const token = match[0];
		if (token.startsWith("`")) {
			parts.push(
				<Text key={`${key}-${n++}`} style={[styles.inlineCode, { backgroundColor: p.elevated, color: p.text }]}>
					{token.slice(1, -1)}
				</Text>,
			);
		} else {
			parts.push(
				<Text key={`${key}-${n++}`} style={styles.bold}>
					{token.slice(2, -2)}
				</Text>,
			);
		}
		last = match.index + token.length;
		match = pattern.exec(text);
	}
	if (last < text.length) parts.push(text.slice(last));
	return parts;
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const p = usePalette();
	const blocks = parseBlocks(text);
	return (
		<View style={styles.root}>
			{blocks.map((block, index) => {
				const key = `b${index}`;
				switch (block.kind) {
					case "code":
						return (
							<ScrollView
								key={key}
								horizontal
								style={[styles.codeBlock, { backgroundColor: p.code, borderColor: p.border }]}
							>
								<Text selectable style={[styles.code, { color: p.codeText }]}>
									{block.text}
								</Text>
							</ScrollView>
						);
					case "heading":
						return (
							<Text
								key={key}
								selectable
								style={[styles.heading, { color: p.text, fontSize: block.level <= 2 ? 18 : 16 }]}
							>
								{inline(block.text, p, key)}
							</Text>
						);
					case "list":
						return (
							<View key={key} style={[styles.listRow, { paddingLeft: block.indent * 14 }]}>
								<Text style={[styles.text, styles.bullet, { color: p.muted }]}>{block.bullet}</Text>
								<Text selectable style={[styles.text, styles.listText, { color: p.text }]}>
									{inline(block.text, p, key)}
								</Text>
							</View>
						);
					case "quote":
						return (
							<Text key={key} selectable style={[styles.text, styles.quote, { color: p.muted, borderColor: p.accent }]}>
								{inline(block.text, p, key)}
							</Text>
						);
					default:
						return (
							<Text key={key} selectable style={[styles.text, { color: p.text }]}>
								{inline(block.text, p, key)}
							</Text>
						);
				}
			})}
		</View>
	);
});

const styles = StyleSheet.create({
	root: { gap: 8 },
	text: { fontSize: 15, lineHeight: 22 },
	bold: { fontWeight: "700" },
	inlineCode: { fontFamily: MONO, fontSize: 13, borderRadius: 5 },
	heading: { fontWeight: "700", marginTop: 4 },
	codeBlock: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, maxHeight: 360 },
	code: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18 },
	listRow: { flexDirection: "row", gap: 6 },
	bullet: { minWidth: 14 },
	listText: { flex: 1 },
	quote: { borderLeftWidth: 3, paddingLeft: 12, borderRadius: 2 },
});
