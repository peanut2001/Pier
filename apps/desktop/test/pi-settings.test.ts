import { describe, expect, it } from "vitest";
import {
	builtinDefault,
	currentPackageManager,
	type FieldDef,
	formatValue,
	getPath,
	isValidValue,
	parseListInput,
	parseNumberInput,
	parseSettingsText,
	SETTINGS_GROUPS,
	unhandledKeys,
} from "../src/lib/pi-settings.ts";

function field(path: string): FieldDef {
	const found = SETTINGS_GROUPS.flatMap((g) => g.fields).find((f) => f.path.join(".") === path);
	if (!found) throw new Error(`No field ${path}`);
	return found;
}

describe("pi settings fields", () => {
	it("lists every key once", () => {
		const keys = SETTINGS_GROUPS.flatMap((g) => g.fields.map((f) => f.path.join(".")));
		expect(new Set(keys).size).toBe(keys.length);
	});

	it("reads nested values without walking into non-objects", () => {
		const settings = { compaction: { enabled: false }, terminal: "odd" };
		expect(getPath(settings, ["compaction", "enabled"])).toBe(false);
		expect(getPath(settings, ["terminal", "showImages"])).toBeUndefined();
		expect(getPath(undefined, ["theme"])).toBeUndefined();
		expect(getPath({}, ["toString"])).toBeUndefined();
	});

	it("validates values per field kind", () => {
		expect(isValidValue(field("compaction.enabled").kind, true)).toBe(true);
		expect(isValidValue(field("compaction.enabled").kind, "yes")).toBe(false);
		expect(isValidValue(field("terminal.images").kind, false)).toBe(true);
		expect(isValidValue(field("terminal.images").kind, true)).toBe(false);
		expect(isValidValue(field("outputPad").kind, 1)).toBe(true);
		expect(isValidValue(field("defaultTools").kind, ["read"])).toBe(true);
		expect(isValidValue(field("defaultTools").kind, "read")).toBe(false);
	});

	it("formats values and defaults", () => {
		expect(formatValue(field("defaultThinkingLevel"), builtinDefault(field("defaultThinkingLevel")))).toBe("medium");
		expect(formatValue(field("compaction.reserveTokens"), 16384)).toBe("16384 tokens");
		expect(formatValue(field("defaultTools"), builtinDefault(field("defaultTools")))).toBe("read、bash、edit、write");
		expect(formatValue(field("shellPath"), undefined)).toBe("系统默认");
		expect(formatValue(field("terminal.hyperlinks"), "auto")).toBe("自动检测");
	});

	it("parses number and list inputs", () => {
		const reserve = field("compaction.reserveTokens");
		expect(parseNumberInput(reserve, " 8000 ")).toEqual({ value: 8000 });
		expect(parseNumberInput(reserve, "")).toEqual({});
		expect(parseNumberInput(reserve, "1.5").error).toBeDefined();
		expect(parseNumberInput(reserve, "-1").error).toBeDefined();
		expect(parseNumberInput(field("editorPaddingX"), "4").error).toBeDefined();
		expect(parseListInput(" a \n\n b\r\n")).toEqual(["a", "b"]);
		expect(parseListInput(" \n")).toBeUndefined();
	});

	it("finds keys the form does not show", () => {
		expect(
			unhandledKeys({ theme: "dark", packages: [], modelThinkingLevels: {}, compaction: {}, somethingNew: 1 }),
		).toEqual(["modelThinkingLevels", "somethingNew"]);
	});

	it("accepts only JSON objects as the file text", () => {
		expect(parseSettingsText('{ "a": 1 }').settings).toEqual({ a: 1 });
		expect(parseSettingsText("[]").error).toBeDefined();
		expect(parseSettingsText("{ nope").error).toBeDefined();
	});
});

describe("currentPackageManager", () => {
	const managers = [
		{ name: "npm", path: "/home/u/.nvm/versions/node/v22/bin/npm", default: true as const },
		{ name: "npm", path: "/usr/bin/npm" },
		{ name: "pnpm", path: "/home/u/.local/share/pnpm/pnpm", default: true as const },
		{ name: "bun", path: "/home/u/.bun/bin/bun" },
	];

	it("uses the default npm when npmCommand is unset", () => {
		expect(currentPackageManager(undefined, managers)?.path).toBe("/home/u/.nvm/versions/node/v22/bin/npm");
		expect(currentPackageManager([], managers)?.path).toBe("/home/u/.nvm/versions/node/v22/bin/npm");
	});

	it("matches a full path, or a bare name to the first one on PATH", () => {
		expect(currentPackageManager(["/usr/bin/npm"], managers)?.path).toBe("/usr/bin/npm");
		expect(currentPackageManager(["pnpm"], managers)?.path).toBe("/home/u/.local/share/pnpm/pnpm");
		expect(currentPackageManager(["pnpm.cmd"], managers)?.name).toBe("pnpm");
		// bun is only in a well-known directory, not on PATH.
		expect(currentPackageManager(["bun"], managers)).toBeUndefined();
		expect(currentPackageManager(["/opt/other/npm"], managers)).toBeUndefined();
	});

	it("does not guess for wrapper commands", () => {
		expect(currentPackageManager(["mise", "exec", "--", "pnpm"], managers)).toBeUndefined();
	});
});
