import type { TaskSchedule } from "@pier/protocol";

export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function taskScheduleLabel(schedule: TaskSchedule): string {
	switch (schedule.kind) {
		case "once":
			return `单次 · ${taskDate(schedule.at)}`;
		case "interval":
			return schedule.minutes % 60 === 0 ? `每 ${schedule.minutes / 60} 小时` : `每 ${schedule.minutes} 分钟`;
		case "daily":
			return `每天 ${schedule.time} · ${schedule.timeZone}`;
		case "weekly":
			return `${[...new Set(schedule.days)]
				.sort((a, b) => (a || 7) - (b || 7))
				.map((day) => WEEKDAYS[day])
				.join("、")} ${schedule.time} · ${schedule.timeZone}`;
	}
}

export function taskDate(value: string): string {
	return new Date(value).toLocaleString("zh-CN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/** datetime-local uses the viewer's timezone; never truncate a UTC ISO string for this input. */
export function localTaskDate(value: string): string {
	const date = new Date(value);
	return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
