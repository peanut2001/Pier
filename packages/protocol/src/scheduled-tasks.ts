import { z } from "zod";
import { ThinkingLevelSchema } from "./domain.ts";

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "时间格式应为 HH:mm");
const TimeZone = z
	.string()
	.min(1)
	.max(100)
	.refine((value) => {
		try {
			new Intl.DateTimeFormat("en", { timeZone: value });
			return true;
		} catch {
			return false;
		}
	}, "无效的时区");

/** Time-based tasks on the workspace's host (1.36). Weekdays: Sunday = 0. */
export const TaskScheduleSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("once"), at: z.iso.datetime() }),
	z.object({ kind: z.literal("interval"), minutes: z.number().int().min(1).max(525600) }),
	z.object({ kind: z.literal("daily"), time: Time, timeZone: TimeZone }),
	z.object({
		kind: z.literal("weekly"),
		time: Time,
		timeZone: TimeZone,
		days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
	}),
]);
export type TaskSchedule = z.infer<typeof TaskScheduleSchema>;

export const ScheduledTaskInputSchema = z.object({
	name: z.string().trim().min(1).max(200),
	prompt: z.string().trim().min(1).max(100000),
	workspaceId: z.string().min(1).max(256),
	runtime: z
		.string()
		.regex(/^[a-z][a-z0-9-]{0,63}$/)
		.default("pi"),
	schedule: TaskScheduleSchema,
	model: z.object({ provider: z.string().min(1).max(256), modelId: z.string().min(1).max(256) }).optional(),
	thinkingLevel: ThinkingLevelSchema.optional(),
});
export type ScheduledTaskInput = z.infer<typeof ScheduledTaskInputSchema>;

export const ScheduledTaskSchema = ScheduledTaskInputSchema.extend({
	id: z.string().min(1),
	status: z.enum(["active", "paused", "completed"]),
	nextRunAt: z.iso.datetime().nullable(),
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
});
export type ScheduledTask = z.infer<typeof ScheduledTaskSchema>;

export const ScheduledTaskRunSchema = z.object({
	id: z.string().min(1),
	taskId: z.string().min(1),
	taskName: z.string(),
	workspaceId: z.string().min(1),
	runtime: z.string(),
	trigger: z.enum(["schedule", "manual"]),
	status: z.enum(["running", "waiting", "succeeded", "failed", "interrupted"]),
	startedAt: z.iso.datetime(),
	finishedAt: z.iso.datetime().optional(),
	sessionId: z.string().optional(),
	summary: z.string().optional(),
	error: z.string().optional(),
	read: z.boolean(),
});
export type ScheduledTaskRun = z.infer<typeof ScheduledTaskRunSchema>;
