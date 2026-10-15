import { describe, expect, it } from "vitest";
import { joinPath, relativeWorkspacePath } from "../src/lib/format.ts";

describe("joinPath", () => {
	it("joins POSIX paths", () => {
		expect(joinPath("/home/me/project", "src/lib")).toBe("/home/me/project/src/lib");
		expect(joinPath("/", "etc")).toBe("/etc");
		expect(joinPath("/home/me/project", "")).toBe("/home/me/project");
	});

	it("uses backslashes for Windows paths", () => {
		expect(joinPath("C:\\Users\\me\\project", "src/lib")).toBe("C:\\Users\\me\\project\\src\\lib");
		expect(joinPath("D:\\", "work")).toBe("D:\\work");
		expect(joinPath("\\\\server\\share", "a/b")).toBe("\\\\server\\share\\a\\b");
	});
});

describe("relativeWorkspacePath", () => {
	it("converts absolute paths inside a workspace", () => {
		expect(relativeWorkspacePath("/home/me/project", "/home/me/project/exports/report.xlsx")).toBe(
			"exports/report.xlsx",
		);
		expect(relativeWorkspacePath("C:\\Users\\me\\project", "c:/Users/me/project/exports/report.xlsx")).toBe(
			"exports/report.xlsx",
		);
	});

	it("does not let a similarly named sibling escape the workspace", () => {
		expect(relativeWorkspacePath("/home/me/project", "/home/me/project-old/report.xlsx")).toBeUndefined();
		expect(relativeWorkspacePath("/home/me/project", "/home/me/report.xlsx")).toBeUndefined();
	});
});
