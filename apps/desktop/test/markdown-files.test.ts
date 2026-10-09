import { describe, expect, it } from "vitest";
import { markdownFilePath, markdownUrlTransform } from "../src/lib/markdown-files.ts";

describe("Markdown file references", () => {
	it("resolves agent screenshots, encoded filenames and source line references", () => {
		expect(markdownFilePath("/tmp/mobile.png")).toBe("/tmp/mobile.png");
		expect(markdownFilePath("file:///tmp/mobile%20screen.png")).toBe("/tmp/mobile screen.png");
		expect(markdownFilePath("file://localhost/tmp/mobile.png")).toBe("/tmp/mobile.png");
		expect(markdownFilePath("/work/src/app.ts:12:3")).toBe("/work/src/app.ts");
		expect(markdownFilePath("src/app.ts#L12")).toBe("src/app.ts");
		expect(markdownFilePath("file:///C:/Work/screen.png")).toBe("C:/Work/screen.png");
		expect(markdownFilePath("C:\\Work\\app.ts:12")).toBe("C:/Work/app.ts");
		expect(markdownFilePath("docs/%E6%88%AA%E5%9B%BE.png")).toBe("docs/截图.png");
	});

	it("resolves relative references against the viewed Markdown file's directory", () => {
		expect(markdownFilePath("./images/ui.png", "docs")).toBe("docs/./images/ui.png");
		expect(markdownFilePath("../README.md", "docs")).toBe("docs/../README.md");
		expect(markdownFilePath("screen.png", "/tmp/screens")).toBe("/tmp/screens/screen.png");
		expect(markdownFilePath("/tmp/screen.png", "docs")).toBe("/tmp/screen.png");
	});

	it("does not treat web URLs, anchors, unsafe schemes or network shares as local files", () => {
		for (const url of [
			"https://example.com/ui.png",
			"mailto:user@example.com",
			"javascript:alert(1)",
			"data:text/html;base64,AA==",
			"#section",
			"//server/share/ui.png",
			"\\\\server\\share\\ui.png",
			"file://server/share/ui.png",
			"file:///tmp/%00.png",
			"%2F%2Fserver/share.png",
			"/tmp/%invalid.png",
		]) {
			expect(markdownFilePath(url), url).toBeUndefined();
		}
	});

	it("preserves supported local URLs without allowing executable schemes", () => {
		expect(markdownUrlTransform("file:///tmp/screen.png", "src")).toBe("file:///tmp/screen.png");
		expect(markdownUrlTransform("C:/Work/app.ts:12", "href")).toBe("C:/Work/app.ts:12");
		expect(markdownUrlTransform("https://example.com/", "href")).toBe("https://example.com/");
		expect(markdownUrlTransform("javascript:alert(1)", "href")).toBe("");
		expect(markdownUrlTransform("data:image/png;base64,AA==", "src")).toBe("data:image/png;base64,AA==");
		expect(markdownUrlTransform("data:image/png;base64,AA==", "href")).toBe("");
		expect(markdownUrlTransform("data:image/svg+xml;base64,AA==", "src")).toBe("");
	});
});
