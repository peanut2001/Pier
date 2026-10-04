import { describe, expect, it } from "vitest";
import { shortPath } from "../src/format.ts";

describe("shortPath", () => {
	it("shortens home directories to ~", () => {
		expect(shortPath("/home/me/projects/pier")).toBe("~/projects/pier");
		expect(shortPath("/home/me")).toBe("~");
		expect(shortPath("/Users/me/code")).toBe("~/code");
		expect(shortPath("/root/work")).toBe("~/work");
		expect(shortPath("C:\\Users\\me\\code")).toBe("~\\code");
	});

	it("leaves other paths alone", () => {
		expect(shortPath("/homework/x")).toBe("/homework/x");
		expect(shortPath("/rootfs/a")).toBe("/rootfs/a");
		expect(shortPath("/opt/pier")).toBe("/opt/pier");
		expect(shortPath("D:\\code")).toBe("D:\\code");
	});
});
