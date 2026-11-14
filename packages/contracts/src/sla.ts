import { z } from "zod";

const priorities = ["P1", "P2", "P3", "P4", "P5"] as const;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const target = z.object({
  firstResponseMinutes: z.number().int().min(1).max(525600),
  resolutionMinutes: z.number().int().min(1).max(525600),
  calendar: z.enum(["business", "24x7"]),
});
const holiday = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Use a real calendar date");
export const slaSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    workingWeekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    holidays: z.array(holiday).max(366),
    workdayStart: clock,
    workdayEnd: clock,
    triageFirstResponseMinutes: z.number().int().min(1).max(525600),
    targets: z.record(z.enum(priorities), target),
  })
  .strict()
  .refine((value) => value.workdayEnd > value.workdayStart, {
    message: "Business-hours end must follow start",
  })
  .refine((value) => new Set(value.workingWeekdays).size === value.workingWeekdays.length, {
    message: "Working weekdays must be unique",
  })
  .refine((value) => new Set(value.holidays).size === value.holidays.length, {
    message: "Holiday dates must be unique",
  });
export type SlaSettingsInput = z.infer<typeof slaSettingsSchema>;
export const slaSettingsViewSchema = slaSettingsSchema.extend({
  timezone: z.string(),
  isProposed: z.boolean(),
});
export type SlaSettingsView = z.infer<typeof slaSettingsViewSchema>;

export const proposedSlaSettings: SlaSettingsInput = {
  revision: 0,
  workingWeekdays: [1, 2, 3, 4, 5],
  holidays: [],
  workdayStart: "09:00",
  workdayEnd: "17:00",
  triageFirstResponseMinutes: 60,
  targets: {
    P1: { firstResponseMinutes: 60, resolutionMinutes: 240, calendar: "24x7" },
    P2: { firstResponseMinutes: 240, resolutionMinutes: 480, calendar: "business" },
    P3: { firstResponseMinutes: 480, resolutionMinutes: 1440, calendar: "business" },
    P4: { firstResponseMinutes: 960, resolutionMinutes: 2400, calendar: "business" },
    P5: { firstResponseMinutes: 2400, resolutionMinutes: 9600, calendar: "business" },
  },
};
