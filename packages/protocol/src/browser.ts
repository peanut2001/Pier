import { z } from "zod";

/** Actions shared by local windows and browsers running on the workspace host. */
export const BrowserCommandSchema = z.object({
	action: z.enum(["tabs", "navigate", "snapshot", "click", "fill", "press", "evaluate", "screenshot"]),
	tabId: z.string().max(256).optional(),
	url: z.string().max(8192).optional(),
	selector: z.string().max(4096).optional(),
	text: z.string().max(100_000).optional(),
	key: z.enum(["Enter", "Tab", "Escape", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]).optional(),
	expression: z.string().max(100_000).optional(),
});
export type BrowserCommand = z.infer<typeof BrowserCommandSchema>;

export interface BrowserResult {
	text?: string;
	image?: { data: string; mimeType: "image/png" };
}

export interface LocalBrowserInfo {
	browserId: string;
	workspaceId: string;
	peerId?: string;
	url: string;
	localUrl: string;
	mode: "service" | "network" | "remote";
	controllable: boolean;
	transport?: BrowserTransport;
}

export type BrowserTransport = "webrtc" | "websockets";

/** A session on the workspace host. Only its owning connection receives the access token. */
export interface RemoteBrowserInfo {
	browserId: string;
	workspaceId: string;
	port: number;
	token: string;
	transport: BrowserTransport;
}
