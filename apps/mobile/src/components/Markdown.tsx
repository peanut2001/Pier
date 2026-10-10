import type { BlockContent, DefinitionContent, List, PhrasingContent, Root, RootContent, Table } from "mdast";
import { memo, type ReactNode, useMemo } from "react";
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import { parseMarkdown, safeUrl, tableColumnWidths } from "../markdown.ts";
import { MONO, type Palette, usePalette } from "../theme.ts";

/**
 * Native Markdown renderer for chat text. Parsing is remark-parse + remark-gfm (the same
 * parser as the desktop app); this file only maps the resulting mdast nodes onto
 * React Native views, so tables, task lists, links, emphasis, strikethrough, rules and
 * footnotes render instead of leaking their syntax.
 */

type Ctx = { p: Palette; color: string; depth: number };

function parse(text: string): Root {
	try {
		return parseMarkdown(text);
	} catch {
		return { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] };
	}
}

function open(url: string | undefined) {
	if (url) void Linking.openURL(url).catch(() => undefined);
}

function renderInline(nodes: PhrasingContent[], ctx: Ctx, key: string): ReactNode[] {
	return nodes.map((node, index) => {
		const k = `${key}.${index}`;
		switch (node.type) {
			case "text":
				return node.value;
			case "break":
				return "\n";
			case "strong":
				return (
					<Text key={k} style={styles.bold}>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			case "emphasis":
				return (
					<Text key={k} style={styles.italic}>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			case "delete":
				return (
					<Text key={k} style={styles.strike}>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			case "inlineCode":
				return (
					<Text key={k} style={[styles.inlineCode, { backgroundColor: ctx.p.elevated, color: ctx.p.text }]}>
						{node.value}
					</Text>
				);
			case "link": {
				const url = safeUrl(node.url);
				return (
					<Text
						key={k}
						style={url ? [styles.link, { color: ctx.p.accentText }] : undefined}
						onPress={url ? () => open(url) : undefined}
						accessibilityRole={url ? "link" : undefined}
					>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			}
			case "image": {
				const url = safeUrl(node.url);
				const label = `[图片${node.alt ? `: ${node.alt}` : ""}]`;
				return (
					<Text
						key={k}
						style={url ? [styles.link, { color: ctx.p.accentText }] : { color: ctx.p.muted }}
						onPress={url ? () => open(url) : undefined}
						accessibilityRole={url ? "link" : undefined}
					>
						{label}
					</Text>
				);
			}
			case "linkReference":
				return (
					<Text key={k} style={[styles.link, { color: ctx.p.accentText }]}>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			case "imageReference":
				return `[图片${node.alt ? `: ${node.alt}` : ""}]`;
			case "footnoteReference":
				return (
					<Text key={k} style={[styles.footnoteRef, { color: ctx.p.accentText }]}>
						[{node.label ?? node.identifier}]
					</Text>
				);
			case "html":
				return node.value;
			default:
				return null;
		}
	});
}

function renderList(list: List, ctx: Ctx, key: string): ReactNode {
	const start = list.start ?? 1;
	const nested = { ...ctx, depth: ctx.depth + 1 };
	return (
		<View key={key} style={[styles.list, { gap: list.spread ? 8 : 4 }]}>
			{list.children.map((item, index) => {
				const k = `${key}.${index}`;
				const task = typeof item.checked === "boolean";
				const bullet = task
					? item.checked
						? "☑"
						: "☐"
					: list.ordered
						? `${start + index}.`
						: ctx.depth > 0
							? "◦"
							: "•";
				return (
					<View key={k} style={styles.listRow}>
						<Text
							style={[
								styles.text,
								styles.bullet,
								{ color: task && item.checked ? ctx.p.accent : ctx.p.muted },
								list.ordered && !task ? styles.ordinal : null,
							]}
						>
							{bullet}
						</Text>
						<View style={[styles.listBody, { gap: item.spread ? 8 : 4 }]}>
							{renderBlocks(item.children, nested, k)}
						</View>
					</View>
				);
			})}
		</View>
	);
}

const ALIGN: Record<string, TextStyle["textAlign"]> = { left: "left", center: "center", right: "right" };

function renderTable(table: Table, ctx: Ctx, key: string): ReactNode {
	const widths = tableColumnWidths(table);
	const { p } = ctx;
	return (
		<ScrollView key={key} horizontal showsHorizontalScrollIndicator={false} style={styles.tableScroll}>
			<View style={[styles.table, { borderColor: p.border }]}>
				{table.children.map((row, rowIndex) => {
					const rk = `${key}.${rowIndex}`;
					const header = rowIndex === 0;
					return (
						<View
							key={rk}
							style={[
								styles.tableRow,
								header ? { backgroundColor: p.elevated } : null,
								rowIndex > 0 ? { borderTopWidth: StyleSheet.hairlineWidth, borderColor: p.border } : null,
							]}
						>
							{widths.map((width, column) => {
								const cell = row.children[column];
								const ck = `${rk}.${column}`;
								const align = ALIGN[table.align?.[column] ?? ""] ?? "left";
								return (
									<View
										key={ck}
										style={[
											styles.tableCell,
											{ width },
											column > 0 ? { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: p.border } : null,
										]}
									>
										<Text
											selectable
											style={[styles.tableText, { color: p.text, textAlign: align }, header ? styles.bold : null]}
										>
											{cell ? renderInline(cell.children, ctx, ck) : null}
										</Text>
									</View>
								);
							})}
						</View>
					);
				})}
			</View>
		</ScrollView>
	);
}

function renderBlocks(nodes: (RootContent | BlockContent | DefinitionContent)[], ctx: Ctx, key: string): ReactNode[] {
	const { p } = ctx;
	return nodes.map((node, index) => {
		const k = `${key}.${index}`;
		switch (node.type) {
			case "paragraph":
				return (
					<Text key={k} selectable style={[styles.text, { color: ctx.color }]}>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			case "heading":
				return (
					<Text
						key={k}
						selectable
						style={[styles.heading, { color: ctx.color, fontSize: HEADING_SIZE[node.depth] ?? 15 }]}
					>
						{renderInline(node.children, ctx, k)}
					</Text>
				);
			case "code":
				return (
					<ScrollView key={k} horizontal style={[styles.codeBlock, { backgroundColor: p.code, borderColor: p.border }]}>
						<Text selectable style={[styles.code, { color: p.codeText }]}>
							{node.value}
						</Text>
					</ScrollView>
				);
			case "list":
				return renderList(node, ctx, k);
			case "blockquote":
				return (
					<View key={k} style={[styles.quote, { borderColor: p.accent }]}>
						{renderBlocks(node.children, { ...ctx, color: p.muted }, k)}
					</View>
				);
			case "table":
				return renderTable(node, ctx, k);
			case "thematicBreak":
				return <View key={k} style={[styles.rule, { backgroundColor: p.border }]} />;
			case "html":
				return (
					<Text key={k} selectable style={[styles.text, { color: p.muted }]}>
						{node.value}
					</Text>
				);
			case "footnoteDefinition":
				return (
					<View key={k} style={styles.footnote}>
						<Text style={[styles.small, { color: p.accentText }]}>[{node.label ?? node.identifier}]</Text>
						<View style={styles.listBody}>{renderBlocks(node.children, { ...ctx, color: p.muted }, k)}</View>
					</View>
				);
			default:
				return null;
		}
	});
}

const HEADING_SIZE: Record<number, number> = { 1: 20, 2: 18, 3: 16 };

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	const p = usePalette();
	const tree = useMemo(() => parse(text), [text]);
	return <View style={styles.root}>{renderBlocks(tree.children, { p, color: p.text, depth: 0 }, "b")}</View>;
});

const styles = StyleSheet.create({
	root: { gap: 8 },
	text: { fontSize: 15, lineHeight: 22 },
	small: { fontSize: 13, lineHeight: 20 },
	bold: { fontWeight: "700" },
	italic: { fontStyle: "italic" },
	strike: { textDecorationLine: "line-through" },
	link: { textDecorationLine: "underline" },
	footnoteRef: { fontSize: 12 },
	inlineCode: { fontFamily: MONO, fontSize: 13, borderRadius: 5 },
	heading: { fontWeight: "700", marginTop: 4 },
	codeBlock: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, maxHeight: 360 },
	code: { fontFamily: MONO, fontSize: 12.5, lineHeight: 18 },
	list: {},
	listRow: { flexDirection: "row", gap: 6 },
	bullet: { minWidth: 14 },
	ordinal: { minWidth: 20, textAlign: "right" },
	listBody: { flex: 1, gap: 4 },
	quote: { borderLeftWidth: 3, paddingLeft: 12, borderRadius: 2, gap: 6 },
	rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
	tableScroll: { flexGrow: 0 },
	table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: "hidden" },
	tableRow: { flexDirection: "row" },
	tableCell: { paddingHorizontal: 10, paddingVertical: 7 },
	tableText: { fontSize: 13.5, lineHeight: 19 },
	footnote: { flexDirection: "row", gap: 6 },
});
