import { type ComponentProps, memo, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useStore } from "../lib/store.tsx";
import { IconCheck, IconCopy } from "./Icons.tsx";

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node) {
		return textOf((node as { props: { children?: ReactNode } }).props.children);
	}
	return "";
}

export function CopyButton({ text, label = "复制", iconOnly }: { text: string; label?: string; iconOnly?: boolean }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className={`copy-button${iconOnly ? " icon-only" : ""}${copied ? " copied" : ""}`}
			title={iconOnly ? label : undefined}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
			{iconOnly ? null : <span>{copied ? "已复制" : label}</span>}
		</button>
	);
}

function languageOf(node: ReactNode): string | undefined {
	const child = Array.isArray(node) ? node[0] : node;
	if (child && typeof child === "object" && "props" in child) {
		const className = (child as { props: { className?: unknown } }).props.className;
		const match = typeof className === "string" ? /language-([\w+#-]+)/.exec(className) : null;
		return match?.[1];
	}
	return undefined;
}

function Pre(props: ComponentProps<"pre">) {
	const text = textOf(props.children);
	const language = languageOf(props.children);
	return (
		<div className="code-block">
			<div className="code-block-header">
				<span className="code-lang">{language ?? "code"}</span>
				<CopyButton text={text.replace(/\n$/, "")} />
			</div>
			<pre {...props} />
		</div>
	);
}

function Link({ href, children }: ComponentProps<"a">) {
	const store = useStore();
	return (
		<a
			href={href}
			onClick={(event) => {
				event.preventDefault();
				if (href && /^https?:\/\//.test(href)) store.openExternal(href);
			}}
		>
			{children}
		</a>
	);
}

const components = { pre: Pre, a: Link };
const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as ComponentProps<
	typeof ReactMarkdown
>["rehypePlugins"];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown">
			<ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
				{text}
			</ReactMarkdown>
		</div>
	);
});
