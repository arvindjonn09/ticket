import type { Prisma } from "@prisma/client";
import { addTargetMinutes, type HourCalendar } from "@astrama/domain";
import { proposedSlaSettings, slaSettingsSchema, type SlaSettingsView } from "@astrama/contracts";
import type { Tx } from "../../database.js";

export async function readSlaSettings(tx: Tx, tenantId: string): Promise<SlaSettingsView> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const row = await tx.slaSettings.findUnique({ where: { tenantId } });
  const config = row ? slaSettingsSchema.parse(row.settings) : proposedSlaSettings;
  return { ...config, revision: row?.revision ?? 0, timezone: tenant.timezone, isProposed: true };
}

export async function makeSlaSnapshot(
  tx: Tx,
  tenantId: string,
  priority: string,
  now: Date,
  untriaged = false,
  resolutionStartedAt = now,
) {
  const settings = await readSlaSettings(tx, tenantId);
  const target = settings.targets[priority as keyof typeof settings.targets];
  if (!target) throw new Error("Missing SLA target for ticket priority");
  const calendar: HourCalendar = {
    timezone: settings.timezone,
    workingWeekdays: settings.workingWeekdays,
    holidays: settings.holidays,
    workdayStart: settings.workdayStart,
    workdayEnd: settings.workdayEnd,
  };
  const firstMinutes = untriaged
    ? settings.triageFirstResponseMinutes
    : target.firstResponseMinutes;
  const firstCalendar = untriaged ? "business" : target.calendar;
  return {
    slaFirstResponseTargetMinutes: firstMinutes,
    slaResolutionTargetMinutes: target.resolutionMinutes,
    slaCalendarType: target.calendar,
    slaFirstResponseCalendarType: firstCalendar,
    slaCalendar: calendar as Prisma.InputJsonValue,
    slaFirstResponseDueAt: addTargetMinutes(now, firstMinutes, calendar, firstCalendar),
    slaResolutionDueAt: addTargetMinutes(
      resolutionStartedAt,
      target.resolutionMinutes,
      calendar,
      target.calendar,
    ),
    slaResolutionStartedAt: resolutionStartedAt,
  };
}
