import {
	type AssistantBlock,
	buildTranscript,
	type ChatState,
	contentText,
	editDiff,
	editReplacements,
	summarizeToolCall,
	type ToolBlock,
	type TranscriptItem,
	toolOutputText,
} from "@pier/chat-state";
import { memo, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { isBusy, truncate } from "../format.ts";
import { MONO, type Palette, usePalette } from "../theme.ts";
import { Markdown } from "./Markdown.tsx";

const STATUS_LABEL: Record<ToolBlock["status"], string> = {
	generating: "生成中",
	pending: "等待执行",
	running: "执行中",
	done: "完成",
	error: "失败",
	interrupted: "已中断",
};

const TOOL_LABEL: Record<string, string> = {
	bash: "终端",
	powershell: "PowerShell",
	read: "读取",
	write: "写入",
	edit: "编辑",
	grep: "搜索",
	find: "查找",
	ls: "列目录",
};

/** Keep very long outputs cheap to render on a phone. */
const MAX_OUTPUT_CHARS = 20_000;

function statusColor(p: Palette, status: ToolBlock["status"]): string {
	if (status === "error") return p.danger;
	if (status === "done") return p.ok;
	if (status === "running" || status === "generating") return p.accent;
	if (status === "pending") return p.warning;
	return p.faint;
}

function DiffView({ diff }: { diff: string }) {
	const p = usePalette();
	const lines = truncate(diff, MAX_OUTPUT_CHARS).split("\n");
	return (
		<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
			<View>
				{lines.map((line, i) => {
					const color = line.startsWith("+") ? p.add : line.startsWith("-") ? p.del : p.codeText;
					return (
						// biome-ignore lint/suspicious/noArrayIndexKey: static diff lines.
						<Text key={i} style={[styles.mono, { color }]}>
							{line || " "}
						</Text>
					);
				})}
			</View>
		</ScrollView>
	);
}

export const ToolCard = memo(function ToolCard({ block }: { block: ToolBlock }) {
	const p = usePalette();
	const { call, status } = block;
	const [open, setOpen] = useState(status === "running" || status === "error");
	const summary = summarizeToolCall(call.name, call.arguments);
	const result = block.result ?? block.execution?.result;
	const output = toolOutputText(result ?? block.execution?.partialResult);
	const diff = call.name === "edit" ? editDiff(result) : undefined;
	const replacements = call.name === "edit" && !diff ? editReplacements(call.arguments) : [];
	const writeContent =
		call.name === "write" && typeof (call.arguments as { content?: unknown })?.content === "string"
			? String((call.arguments as { content: string }).content)
			: undefined;

	return (
		<View style={[styles.tool, { borderColor: p.border, backgroundColor: p.card }]}>
			<Pressable style={styles.toolHeader} onPress={() => setOpen(!open)} accessibilityRole="button">
				<Text style={[styles.toolName, { color: p.accent }]}>{TOOL_LABEL[call.name] ?? call.name}</Text>
				<Text style={[styles.toolSummary, { color: p.text }]} numberOfLines={open ? 6 : 1}>
					{summary}
				</Text>
				{status === "running" ? (
					<ActivityIndicator size="small" color={p.accent} />
				) : (
					<Text style={[styles.toolStatus, { color: statusColor(p, status) }]}>{STATUS_LABEL[status]}</Text>
				)}
			</Pressable>
			{open ? (
				<View style={styles.toolBody}>
					{diff ? <DiffView diff={diff} /> : null}
					{replacements.map((r, i) => (
						<DiffView
							// biome-ignore lint/suspicious/noArrayIndexKey: replacements have no id.
							key={i}
							diff={[...r.oldText.split("\n").map((l) => `-${l}`), ...r.newText.split("\n").map((l) => `+${l}`)].join(
								"\n",
							)}
						/>
					))}
					{writeContent !== undefined && !output ? (
						<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
							<Text style={[styles.mono, { color: p.codeText }]}>{truncate(writeContent, MAX_OUTPUT_CHARS)}</Text>
						</ScrollView>
					) : null}
					{output && !diff ? (
						<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
							<Text selectable style={[styles.mono, { color: status === "error" ? p.del : p.codeText }]}>
								{output.length > MAX_OUTPUT_CHARS ? `…${output.slice(-MAX_OUTPUT_CHARS)}` : output}
							</Text>
						</ScrollView>
					) : null}
				</View>
			) : null}
		</View>
	);
});

function Thinking({ text, redacted, live }: { text: string; redacted: boolean; live: boolean }) {
	const p = usePalette();
	const [open, setOpen] = useState(false);
	return (
		<Pressable onPress={() => setOpen(!open)} style={[styles.thinking, { backgroundColor: p.elevated }]}>
			<Text style={[styles.thinkingLabel, { color: p.muted }]}>
				{redacted ? "思考内容已隐藏" : live ? "思考中…" : "思考过程"}
				{redacted ? "" : open ? "  ▾" : "  ▸"}
			</Text>
			{open && !redacted ? <Text style={[styles.thinkingText, { color: p.muted }]}>{text}</Text> : null}
		</Pressable>
	);
}

function AssistantItem({ blocks, streaming }: { blocks: AssistantBlock[]; streaming: boolean }) {
	return (
		<View style={styles.assistant}>
			{blocks.map((block, index) => {
				const key = `${block.kind}-${index}`;
				if (block.kind === "text") return <Markdown key={key} text={block.text} />;
				if (block.kind === "thinking") {
					return (
						<Thinking
							key={key}
							text={block.text}
							redacted={block.redacted}
							live={streaming && index === blocks.length - 1}
						/>
					);
				}
				return <ToolCard key={block.call.id} block={block} />;
			})}
		</View>
	);
}

const TranscriptRow = memo(function TranscriptRow({ item }: { item: TranscriptItem }) {
	const p = usePalette();
	switch (item.kind) {
		case "user":
			return (
				<View style={[styles.user, { backgroundColor: p.userBubble }]}>
					{item.images.map((image, i) => (
						<Image
							// biome-ignore lint/suspicious/noArrayIndexKey: images have no id.
							key={i}
							source={{ uri: `data:${image.mimeType};base64,${image.data}` }}
							style={styles.userImage}
							resizeMode="cover"
						/>
					))}
					{item.text ? (
						<Text selectable style={[styles.userText, { color: p.text }]}>
							{item.text}
						</Text>
					) : null}
				</View>
			);
		case "assistant":
			return <AssistantItem blocks={item.blocks} streaming={item.streaming} />;
		case "bash":
			return (
				<View style={[styles.tool, { borderColor: p.border, backgroundColor: p.card }]}>
					<Text style={[styles.toolSummary, styles.pad, { color: p.text }]}>$ {item.message.command}</Text>
					<ScrollView horizontal style={[styles.output, { backgroundColor: p.code }]}>
						<Text style={[styles.mono, { color: p.codeText }]}>
							{truncate(item.message.output ?? "", MAX_OUTPUT_CHARS)}
						</Text>
					</ScrollView>
				</View>
			);
		case "compaction":
			return <Text style={[styles.notice, { color: p.muted }]}>—— 上下文已压缩 ——</Text>;
		case "branchSummary":
			return <Text style={[styles.notice, { color: p.muted }]}>—— 分支摘要 ——</Text>;
		case "custom":
			return item.text ? <Markdown text={item.text} /> : null;
		case "toolResult":
			return (
				<Text style={[styles.notice, { color: p.muted }]} numberOfLines={3}>
					{contentText(item.message.content)}
				</Text>
			);
		default:
			return null;
	}
});

export function Transcript({ chat }: { chat: ChatState }) {
	const p = usePalette();
	const items = useMemo(() => buildTranscript(chat), [chat]);
	const last = items[items.length - 1];
	const waiting =
		isBusy(chat.runState) &&
		!chat.pendingUi.length &&
		!(last?.kind === "assistant" && last.streaming && last.blocks.length > 0);
	return (
		<View style={styles.transcript}>
			{items.map((item) => (
				<TranscriptRow key={item.key} item={item} />
			))}
			{waiting ? (
				<View style={[styles.waiting, { backgroundColor: p.accentSoft }]}>
					<ActivityIndicator size="small" color={p.accent} />
					<Text style={[styles.waitingText, { color: p.accent }]}>
						{chat.runState === "compacting" ? "正在压缩上下文…" : "Agent 工作中…"}
					</Text>
				</View>
			) : null}
			{chat.errorMessage && !isBusy(chat.runState) ? (
				<Text style={[styles.error, { color: p.danger, backgroundColor: p.dangerSoft }]}>{chat.errorMessage}</Text>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	transcript: { gap: 16, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 24 },
	user: {
		alignSelf: "flex-end",
		maxWidth: "86%",
		borderRadius: 20,
		borderBottomRightRadius: 6,
		paddingHorizontal: 14,
		paddingVertical: 10,
		gap: 6,
	},
	userText: { fontSize: 15.5, lineHeight: 22 },
	userImage: { width: 160, height: 120, borderRadius: 12 },
	assistant: { gap: 10 },
	tool: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden" },
	toolHeader: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
	toolName: { fontSize: 12, fontWeight: "700" },
	toolSummary: { flex: 1, fontFamily: MONO, fontSize: 12.5 },
	toolStatus: { fontSize: 12, fontWeight: "500" },
	toolBody: { gap: 6, paddingHorizontal: 8, paddingBottom: 8 },
	output: { borderRadius: 8, padding: 10, maxHeight: 280 },
	mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
	pad: { padding: 12 },
	thinking: { alignSelf: "flex-start", maxWidth: "100%", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 7 },
	thinkingLabel: { fontSize: 13, fontWeight: "500" },
	thinkingText: { fontSize: 13, lineHeight: 19, marginTop: 6 },
	notice: { textAlign: "center", fontSize: 12 },
	waiting: {
		alignSelf: "flex-start",
		flexDirection: "row",
		alignItems: "center",
		gap: 8,
		paddingHorizontal: 12,
		paddingVertical: 7,
		borderRadius: 999,
	},
	waitingText: { fontSize: 13, fontWeight: "600" },
	error: { padding: 12, borderRadius: 12, fontSize: 13, overflow: "hidden" },
});
