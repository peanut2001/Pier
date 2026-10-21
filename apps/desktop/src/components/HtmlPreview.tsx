import { convertFileSrc } from "@tauri-apps/api/core";
import { useRef } from "react";
import { isTauri } from "../lib/bridge.ts";
import previewShell from "../lib/html-preview.html?raw";

/** A separate document keeps file scripts and styles out of the Pier UI. */
export function HtmlPreview({ html, title }: { html: string; title: string }) {
	const sent = useRef(false);
	return (
		<iframe
			className="file-viewer-html"
			title={`${title} 预览`}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			// srcdoc inherits the app's CSP, which blocks inline scripts in packaged builds.
			// The desktop protocol serves only the isolated shell, with its own restrictive CSP.
			src={isTauri ? convertFileSrc("index.html", "pier-preview") : undefined}
			srcDoc={isTauri ? undefined : previewShell}
			onLoad={(event) => {
				// Never send the file again if a link navigates this frame to another page.
				if (sent.current) return;
				sent.current = true;
				// Sandboxed frames have an opaque origin; address only this frame's window.
				event.currentTarget.contentWindow?.postMessage({ type: "pier:html-preview", html }, "*");
			}}
		/>
	);
}
