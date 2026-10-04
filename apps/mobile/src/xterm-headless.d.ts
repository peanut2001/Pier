/**
 * `@xterm/headless` points its `module` field at a file it does not ship, which breaks the web
 * bundle; `src/terminal.ts` imports the CommonJS build directly instead.
 */
declare module "@xterm/headless/lib-headless/xterm-headless.js" {
	export * from "@xterm/headless";
}
