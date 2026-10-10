import type { HostInfo } from "@pier/protocol";
import { describe, expect, it } from "vitest";
import {
	filePreviewAuthorizationPath,
	filePreviewError,
	markdownFilePath,
	markdownUrlTransform,
} from "../src/lib/markdown-files.ts";
import { hostAuthorizesFilePreviews } from "../src/lib/store.tsx";

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

describe("file preview permission errors", () => {
	const error = (code: string, message: string, data?: unknown) => Object.assign(new Error(message), { code, data });

	it("requires remote preview support on the target host while keeping older local previews available", () => {
		const host = (protocolVersion: string) => ({ protocolVersion }) as HostInfo;
		expect(hostAuthorizesFilePreviews(host("1.32"))).toBe(false);
		for (const version of ["1.33", "1.34"]) {
			expect(hostAuthorizesFilePreviews(host(version))).toBe(true);
			expect(hostAuthorizesFilePreviews(host(version), true)).toBe(false);
		}
		expect(hostAuthorizesFilePreviews(host("1.35"), true)).toBe(true);
		expect(hostAuthorizesFilePreviews(undefined, true)).toBe(false);
	});

	it("offers authorization only for a resolved path refused by the host boundary", () => {
		const outside = error("FORBIDDEN", "outside", {
			reason: "OUTSIDE_ALLOWED_ROOTS",
			resolvedPath: "/home/me/ui.html",
		});
		expect(filePreviewAuthorizationPath(outside)).toBe("/home/me/ui.html");
		expect(filePreviewError(outside)).toContain("需要授权");
		expect(
			filePreviewError(error("FORBIDDEN", "Preview path is outside the workspace and temporary directories")),
		).toContain("请更新");
		for (const denied of [
			error("FORBIDDEN", "Permission denied: /home/me/ui.html", { reason: "FILESYSTEM_PERMISSION_DENIED" }),
			error("FORBIDDEN", "unknown"),
			error("FORBIDDEN", "outside", { reason: "OUTSIDE_ALLOWED_ROOTS", resolvedPath: 123 }),
			error("NOT_FOUND", "missing", { reason: "OUTSIDE_ALLOWED_ROOTS", resolvedPath: "/missing" }),
			undefined,
		]) {
			expect(filePreviewAuthorizationPath(denied)).toBeUndefined();
		}
	});

	it("explains system permissions and requests fresh confirmation for changed targets", () => {
		const denied = error("FORBIDDEN", "Permission denied: /Desktop/ui.html", {
			reason: "FILESYSTEM_PERMISSION_DENIED",
		});
		expect(filePreviewError(denied, "darwin")).toContain("文件与文件夹");
		expect(filePreviewError(denied, "linux")).toContain("读取权限");
		expect(filePreviewError(error("FORBIDDEN", "Permission denied: /Desktop/ui.html"), "darwin")).toContain("macOS");
		expect(filePreviewError(error("CONFLICT", "changed", { reason: "PREVIEW_TARGET_CHANGED" }))).toContain("重新确认");
	});
});
