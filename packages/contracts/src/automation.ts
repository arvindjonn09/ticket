import { z } from "zod";

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, "Use a valid calendar date");
export const automationSettingsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    workingWeekdays: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "Working weekdays must be unique"),
    holidays: z
      .array(calendarDate)
      .max(366)
      .refine((days) => new Set(days).size === days.length, "Holiday dates must be unique"),
    reminderDays: z.number().int().min(1).max(365),
    escalationDays: z.number().int().min(1).max(365),
    autoCloseDays: z.number().int().min(1).max(365),
  })
  .strict()
  .refine(
    (settings) => settings.escalationDays >= settings.reminderDays,
    "Escalation cannot precede the reminder",
  );
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;
export type AutomationSettingsView = AutomationSettings & {
  timezone: string;
  responsibleAdminId: string | null;
};
