import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { proposedSlaSettings } from "@astrama/contracts";
import { addTargetMinutes, type HourCalendar } from "@astrama/domain";
import { Database } from "../src/database.js";
import { TicketsService } from "../src/modules/tickets/tickets.service.js";
import { SlaService } from "../src/modules/sla/sla.service.js";
import { makeSlaSnapshot } from "../src/modules/sla/sla.policy.js";
import type { AuthContext } from "../src/modules/auth/auth.service.js";

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)(
  "SLA targets on PostgreSQL",
  () => {
    const owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const db = new Database();
    const tickets = new TicketsService(db);
    const sla = new SlaService(db, tickets);
    let tenantId: string;
    let otherTenantId: string;
    let admin: AuthContext;
    let employee: AuthContext;
    let foreignAdmin: AuthContext;
    let agent: AuthContext;
    let categoryId: string;
    let departmentId: string;

    const context = (
      user: { id: string; name: string; email: string; role: string },
      id: string,
    ): AuthContext => ({
      id: user.id,
      tenantId: id,
      role: user.role as AuthContext["role"],
      departmentIds: [],
      sessionId: randomUUID(),
      view: {
        user: { ...user, role: user.role as AuthContext["role"], departmentIds: [] },
        tenant: {
          id,
          slug: "sla-test",
          name: "SLA test",
          brandName: "Test",
          timezone: "Australia/Sydney",
        },
        csrfToken: "test",
        mfaVerified: user.role !== "employee",
      },
    });

    async function makeUser(id: string, role: string) {
      const user = await owner.user.create({
        data: {
          tenantId: id,
          name: role,
          email: `${role}-${randomUUID()}@test.invalid`,
          role,
          passwordHash: "disabled",
          mfaEnrolled: role !== "employee",
          mfaSecret: role !== "employee" ? "test-secret" : null,
        },
      });
      const auth = context(user, id);
      await owner.session.create({
        data: {
          id: auth.sessionId,
          tenantId: id,
          userId: user.id,
          tokenHash: randomUUID(),
          csrfToken: "test",
          mfaVerified: role !== "employee",
          expiresAt: new Date(Date.now() + 3600000),
        },
      });
      return auth;
    }

    beforeAll(async () => {
      await db.assertRuntimeRole();
      tenantId = (
        await owner.tenant.create({
          data: { slug: `sla-${randomUUID()}`, name: "SLA test", brandName: "Test" },
        })
      ).id;
      otherTenantId = (
        await owner.tenant.create({
          data: { slug: `sla-other-${randomUUID()}`, name: "Other", brandName: "Test" },
        })
      ).id;
      admin = await makeUser(tenantId, "admin");
      employee = await makeUser(tenantId, "employee");
      agent = await makeUser(tenantId, "agent");
      foreignAdmin = await makeUser(otherTenantId, "admin");
      const department = await owner.department.create({
        data: { tenantId, name: `SLA route ${randomUUID()}` },
      });
      departmentId = department.id;
      const category = await owner.category.create({
        data: { tenantId, name: `SLA category ${randomUUID()}`, departmentId: department.id },
      });
      categoryId = category.id;
      await owner.membership.create({
        data: { tenantId, userId: agent.id, departmentId: department.id },
      });
    });

    afterAll(async () => {
      await db.$disconnect();
      await owner.$disconnect();
    });

    it("keeps defaults proposed, scopes admin settings by tenant, and snapshots existing targets", async () => {
      const initial = await sla.get(admin);
      expect(initial.isProposed).toBe(true);
      expect(initial.targets.P1).toEqual({
        firstResponseMinutes: 60,
        resolutionMinutes: 240,
        calendar: "24x7",
      });
      await expect(sla.get(employee)).rejects.toThrow();

      const triageSnapshot = await db.withTenant(tenantId, (tx) =>
        makeSlaSnapshot(tx, tenantId, "P2", new Date("2026-11-12T00:00:00Z"), true),
      );
      expect(triageSnapshot.slaFirstResponseTargetMinutes).toBe(60);
      expect(triageSnapshot.slaFirstResponseCalendarType).toBe("business");
      const beforeChange = await db.withTenant(tenantId, (tx) =>
        makeSlaSnapshot(tx, tenantId, "P2", new Date("2026-11-12T00:00:00Z"), false),
      );
      const updated = await sla.save(admin, {
        ...proposedSlaSettings,
        targets: {
          ...proposedSlaSettings.targets,
          P2: { firstResponseMinutes: 30, resolutionMinutes: 90, calendar: "business" },
        },
      });
      expect(updated.revision).toBe(1);
      expect((await sla.get(foreignAdmin)).revision).toBe(0);
      const afterChange = await db.withTenant(tenantId, (tx) =>
        makeSlaSnapshot(tx, tenantId, "P2", new Date("2026-11-12T00:00:00Z"), false),
      );
      expect(beforeChange.slaResolutionTargetMinutes).toBe(480);
      expect(afterChange.slaResolutionTargetMinutes).toBe(90);
      expect(beforeChange.slaResolutionDueAt).not.toEqual(afterChange.slaResolutionDueAt);

      await owner.tenant.update({ where: { id: tenantId }, data: { defaultPriority: "P2" } });
      const created = await tickets.create(
        employee,
        {
          categoryId,
          summary: "SLA snapshot ticket",
          description: "A ticket for SLA snapshot verification",
        },
        randomUUID(),
      );
      const originalStart = new Date("2026-11-12T00:00:00Z");
      await owner.ticket.update({
        where: { id: created.id },
        data: { createdAt: originalStart, slaResolutionStartedAt: originalStart },
      });
      let row = await owner.ticket.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.slaResolutionTargetMinutes).toBe(90);
      expect(row.slaFirstResponseTargetMinutes).toBe(60);
      expect(row.slaFirstResponseCalendarType).toBe("business");

      const triaged = await tickets.manage(agent, created.id, {
        revision: created.revision,
        action: "triage",
        reason: "Corrected impact assessment",
        priority: "P3",
        severity: "S2",
      });
      row = await owner.ticket.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.priority).toBe("P3");
      expect(row.slaResolutionTargetMinutes).toBe(1440);
      const p3Targets = await db.withTenant(tenantId, (tx) =>
        makeSlaSnapshot(tx, tenantId, "P3", originalStart),
      );
      expect(row.slaFirstResponseDueAt).toEqual(p3Targets.slaFirstResponseDueAt);
      expect(row.slaResolutionDueAt).toEqual(p3Targets.slaResolutionDueAt);

      const p4 = await tickets.manage(agent, created.id, {
        revision: triaged.revision,
        action: "triage",
        reason: "Reassessed impact",
        priority: "P4",
        severity: "S2",
      });
      const p3Again = await tickets.manage(agent, created.id, {
        revision: p4.revision,
        action: "triage",
        reason: "Restored impact assessment",
        priority: "P3",
        severity: "S2",
      });
      row = await owner.ticket.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.slaFirstResponseDueAt).toEqual(p3Targets.slaFirstResponseDueAt);
      expect(row.slaResolutionDueAt).toEqual(p3Targets.slaResolutionDueAt);
      expect(
        await owner.audit.findFirst({
          where: {
            ticketId: created.id,
            action: "ticket.triage",
            detail: { path: ["reason"], equals: "Corrected impact assessment" },
          },
        }),
      ).not.toBeNull();
      const priorityAudit = await owner.audit.findFirstOrThrow({
        where: {
          ticketId: created.id,
          action: "ticket.triage",
          detail: { path: ["reason"], equals: "Corrected impact assessment" },
        },
      });
      const dateChanges = (
        priorityAudit.detail as {
          slaDueDates: { old: { firstResponseDueAt: string }; new: { firstResponseDueAt: string } };
        }
      ).slaDueDates;
      expect(dateChanges.old.firstResponseDueAt).not.toBe(dateChanges.new.firstResponseDueAt);

      const inProgress = await tickets.state(agent, created.id, {
        revision: p3Again.revision,
        state: "In Progress",
      });
      const resolved = await tickets.state(agent, created.id, {
        revision: inProgress.revision,
        state: "Resolved",
        resolution: "Restored",
        customerSummary: "Service restored",
      });
      const current = await sla.get(admin);
      const { timezone: _timezone, isProposed: _proposed, ...currentInput } = current;
      void _timezone;
      void _proposed;
      await sla.save(admin, {
        ...currentInput,
        targets: {
          ...current.targets,
          P3: { ...current.targets.P3, resolutionMinutes: 5 },
        },
      });
      await tickets.state(employee, created.id, {
        revision: resolved.revision,
        state: "In Progress",
      });
      row = await owner.ticket.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.slaResolutionTargetMinutes).toBe(1440);
      expect(row.slaResolvedAt).toBeNull();
      const calendar = row.slaCalendar as unknown as HourCalendar;
      expect(row.slaResolutionDueAt).toEqual(
        addTargetMinutes(row.slaResolutionStartedAt!, 1440, calendar, "business"),
      );
    });

    it("emits warning and breach notifications once per target stage", async () => {
      const department = await owner.department.create({
        data: { tenantId, name: `SLA ${randomUUID()}` },
      });
      const category = await owner.category.create({
        data: { tenantId, name: `SLA ${randomUUID()}`, departmentId: department.id },
      });
      const now = new Date();
      const start = new Date(now.getTime() - 45 * 60000);
      const due = new Date(start.getTime() + 60 * 60000);
      const sequence = (await owner.ticket.count({ where: { tenantId, type: "incident" } })) + 1;
      const ticket = await owner.ticket.create({
        data: {
          tenantId,
          type: "incident",
          sequence,
          number: `SLA${String(sequence).padStart(8, "0")}`,
          summary: "SLA timer fixture",
          description: "Fictional integration fixture",
          state: "In Progress",
          priority: "P2",
          severity: "S2",
          categoryId: category.id,
          departmentId: department.id,
          callerId: employee.id,
          submittedById: employee.id,
          createdAt: start,
          slaFirstResponseTargetMinutes: 60,
          slaResolutionTargetMinutes: 60,
          slaCalendarType: "24x7",
          slaFirstResponseCalendarType: "24x7",
          slaCalendar: {
            timezone: "Australia/Sydney",
            workingWeekdays: [1, 2, 3, 4, 5],
            holidays: [],
          },
          slaFirstResponseDueAt: due,
          slaResolutionDueAt: due,
          slaResolutionStartedAt: start,
        },
      });

      await sla.dispatch(now);
      await sla.dispatch(new Date(due.getTime() + 1));
      await sla.dispatch(new Date(due.getTime() + 1));
      expect(await owner.slaAlert.count({ where: { tenantId, ticketId: ticket.id } })).toBe(4);
      expect(
        await owner.outbox.count({
          where: { tenantId, ticketId: ticket.id, event: "sla.warning" },
        }),
      ).toBe(2);
      expect(
        await owner.outbox.count({ where: { tenantId, ticketId: ticket.id, event: "sla.breach" } }),
      ).toBe(2);
      await owner.ticket.update({
        where: { id: ticket.id },
        data: { slaResolutionStartedAt: new Date(start.getTime() - 60000) },
      });
      await sla.dispatch(new Date(due.getTime() + 1));
      expect(
        await owner.slaAlert.count({
          where: { tenantId, ticketId: ticket.id, target: "resolution", stage: "breach" },
        }),
      ).toBe(2);
      const breachEvents = await owner.outbox.findMany({
        where: { tenantId, ticketId: ticket.id, event: "sla.breach" },
      });
      expect(
        breachEvents.every(
          (event) => (event.payload as { audience?: string }).audience === "internal",
        ),
      ).toBe(true);
      expect(
        breachEvents.every((event) => (event.payload as { kind?: string }).kind === "sla"),
      ).toBe(true);
    }, 30000);

    it("evaluates every SLA ticket beyond the first 500 candidates", async () => {
      const now = new Date();
      const start = new Date(now.getTime() - 45 * 60000);
      const maximum = await owner.ticket.aggregate({
        where: { tenantId },
        _max: { sequence: true },
      });
      const rows = Array.from({ length: 505 }, (_, index) => {
        const sequence = (maximum._max.sequence ?? 0) + index + 1;
        return {
          tenantId,
          type: "incident",
          sequence,
          number: `BULK${String(sequence).padStart(8, "0")}`,
          summary: `SLA bulk ${sequence}`,
          description: "Fictional SLA dispatch fixture",
          state: "In Progress",
          priority: "P2",
          severity: "S2",
          categoryId,
          departmentId,
          callerId: employee.id,
          submittedById: employee.id,
          createdAt: start,
          slaFirstResponseTargetMinutes: 60,
          slaResolutionTargetMinutes: null,
          slaCalendarType: "24x7",
          slaFirstResponseCalendarType: "24x7",
          slaCalendar: {
            timezone: "Australia/Sydney",
            workingWeekdays: [1, 2, 3, 4, 5],
            holidays: [],
          },
          slaFirstResponseDueAt: new Date(start.getTime() + 60 * 60000),
          slaResolutionDueAt: null,
          slaResolutionStartedAt: start,
        };
      });
      await owner.ticket.createMany({ data: rows });
      await sla.dispatch(now);
      expect(
        await owner.slaAlert.count({
          where: {
            tenantId,
            target: "first_response",
            stage: "warning",
            ticket: { summary: { startsWith: "SLA bulk " } },
          },
        }),
      ).toBe(505);
    }, 30000);
  },
);
