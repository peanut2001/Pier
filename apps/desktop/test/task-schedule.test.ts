import { afterEach, describe, expect, it, vi } from "vitest";
import { localTaskDate, taskScheduleLabel } from "../src/lib/task-schedule.ts";

afterEach(() => vi.unstubAllEnvs());

describe("task time entry", () => {
	it("converts UTC to local input values across daylight saving time", () => {
		vi.stubEnv("TZ", "America/New_York");
		expect(localTaskDate("2026-03-08T07:30:00Z")).toBe("2026-03-08T03:30");
		expect(localTaskDate("2026-11-01T07:30:00Z")).toBe("2026-11-01T02:30");
	});
	it("shows the saved timezone and displays weekdays in calendar order", () => {
		expect(taskScheduleLabel({ kind: "weekly", time: "09:30", timeZone: "Asia/Shanghai", days: [0, 3, 1, 3] })).toBe(
			"周一、周三、周日 09:30 · Asia/Shanghai",
		);
	});
});
