import { type ComponentProps, memo, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { useStore } from "../lib/store.tsx";

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node) {
		return textOf((node as { props: { children?: ReactNode } }).props.children);
	}
	return "";
}

export function CopyButton({ text, label = "复制" }: { text: string; label?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="copy-button"
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? "已复制" : label}
		</button>
	);
}

function Pre(props: ComponentProps<"pre">) {
	const text = textOf(props.children);
	return (
		<div className="code-block">
			<CopyButton text={text.replace(/\n$/, "")} />
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
