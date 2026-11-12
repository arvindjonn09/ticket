import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, type Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { Database } from "../src/database.js";
import type { NotificationWorker } from "../src/modules/notifications/notifications.service.js";

describe.skipIf(!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL)(
  "launch safety — isolated PostgreSQL/SMTP recipients",
  () => {
    let owner: PrismaClient, db: Database, worker: NotificationWorker;
    let tenantId: string,
      groupId: string,
      categoryId: string,
      itemId: string,
      ticketId: string,
      approvalId: string;
    const users: Record<string, { id: string; email: string }> = {};
    const saved = {
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      from: process.env.SMTP_FROM,
      origin: process.env.APP_ORIGIN,
    };
    const received: { to: string; body: string }[] = [];
    const server = createServer((socket) => {
      socket.write("220 fixture ESMTP\r\n");
      let buffer = "",
        inData = false,
        to = "",
        body = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf("\r\n")) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (inData) {
            if (line === ".") {
              inData = false;
              received.push({ to, body });
              socket.write("250 queued\r\n");
            } else body += line + "\n";
          } else if (line.startsWith("EHLO") || line.startsWith("HELO"))
            socket.write("250 fixture\r\n");
          else if (line.startsWith("MAIL FROM:")) {
            to = "";
            body = "";
            socket.write("250 OK\r\n");
          } else if (line.startsWith("RCPT TO:")) {
            to = line.slice("RCPT TO:".length).trim().replace(/[<>]/g, "");
            socket.write("250 OK\r\n");
          } else if (line === "DATA") {
            inData = true;
            socket.write("354 continue\r\n");
          } else if (line === "QUIT") socket.end("221 bye\r\n");
          else socket.write("250 OK\r\n");
        }
      });
    });
    beforeAll(async () => {
      process.env.NODE_ENV = "test";
      process.env.APP_ORIGIN = "http://localhost:4310";
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("SMTP fixture unavailable");
      process.env.SMTP_HOST = "127.0.0.1";
      process.env.SMTP_PORT = String(address.port);
      process.env.SMTP_FROM = "desk@test.invalid";
      owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
      const { Database } = await import("../dist/database.js");
      const { NotificationWorker } =
        await import("../dist/modules/notifications/notifications.service.js");
      db = new Database();
      worker = new NotificationWorker(db);
      const tenant = await owner.tenant.create({
        data: {
          slug: `launch-safety-${randomUUID()}`,
          name: "Launch fixture",
          brandName: "Fixture",
        },
      });
      tenantId = tenant.id;
      for (const name of [
        "admin",
        "caller",
        "recipient",
        "manager",
        "owner",
        "agent",
        "delegate",
      ]) {
        const user = await owner.user.create({
          data: {
            tenantId,
            name,
            email: `${name}@${tenant.slug}.invalid`,
            role:
              name === "admin" ? "admin" : ["owner", "agent"].includes(name) ? "agent" : "employee",
            passwordHash: "!",
            approverEligible: ["manager", "delegate"].includes(name),
            mfaEnrolled: ["admin", "owner", "agent"].includes(name),
            mfaSecret: ["admin", "owner", "agent"].includes(name)
              ? "isolated-fixture-secret-not-used"
              : null,
          },
        });
        users[name] = { id: user.id, email: user.email };
      }
      await owner.user.update({
        where: { id: users.recipient!.id },
        data: { managerId: users.manager!.id },
      });
      const group = await owner.department.create({
        data: { tenantId, name: "Confidential group", queueOwnerId: users.owner!.id },
      });
      groupId = group.id;
      for (const name of ["owner", "agent"])
        await owner.membership.create({
          data: { tenantId, departmentId: groupId, userId: users[name]!.id },
        });
      categoryId = (
        await owner.category.create({
          data: { tenantId, name: "Confidential category", departmentId: groupId, sensitive: true },
        })
      ).id;
      itemId = (
        await owner.catalogItem.create({
          data: {
            tenantId,
            categoryId,
            name: "Approval item",
            requiresManager: true,
            currency: "AUD",
          },
        })
      ).id;
      const ticket = await owner.ticket.create({
        data: {
          tenantId,
          type: "request",
          sequence: 1,
          number: "SR0001",
          summary: "CONFIDENTIAL-SUMMARY-CANARY",
          description: "INTERNAL-BODY-CANARY",
          state: "Pending Approval",
          priority: "P3",
          severity: "S3",
          sensitive: true,
          callerId: users.caller!.id,
          submittedById: users.caller!.id,
          requestedForId: users.recipient!.id,
          categoryId,
          departmentId: groupId,
          itemId,
          quantity: 1,
          totalCostMinor: 0,
          unitCostMinor: 0,
          currency: "AUD",
          approvalVersion: 1,
        },
      });
      ticketId = ticket.id;
      approvalId = (
        await owner.approval.create({
          data: { tenantId, ticketId, version: 1, stage: "manager", approverId: users.manager!.id },
        })
      ).id;
      await owner.$executeRaw`INSERT INTO automation_settings(tenant_id,enabled,responsible_admin_id,revision) VALUES(${tenantId}::uuid,true,${users.admin!.id}::uuid,1)`;
    }, 30000);
    afterAll(async () => {
      await db?.$disconnect();
      if (owner && tenantId) {
        await owner.user.updateMany({ where: { tenantId }, data: { managerId: null } });
        await owner.department.updateMany({
          where: { tenantId },
          data: { queueOwnerId: null, substituteId: null },
        });
        for (const table of [
          "automation_actions",
          "automation_settings",
          "notification_deliveries",
          "approval_delegations",
          "approvals",
          "idempotency",
          "outbox",
          "audits",
          "config_audits",
          "activities",
          "tickets",
          "catalog_items",
          "sessions",
          "memberships",
          "categories",
          "departments",
          "users",
        ])
          await owner.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE tenant_id=$1::uuid`,
            tenantId,
          );
        await owner.tenant.delete({ where: { id: tenantId } });
        await owner.$disconnect();
      }
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      for (const [name, value] of Object.entries({
        SMTP_HOST: saved.host,
        SMTP_PORT: saved.port,
        SMTP_FROM: saved.from,
        APP_ORIGIN: saved.origin,
      }))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }, 30000);
    const event = async (kind = "approval_reminder", extra: Prisma.InputJsonObject = {}) =>
      owner.outbox.create({
        data: {
          tenantId,
          ticketId,
          event: `automation.${kind}`,
          payload: {
            automation: true,
            kind,
            calendarRevision: 1,
            approvalId,
            approvalVersion: 1,
            stage: "manager",
            ...extra,
          },
        },
      });
    const deliver = async (id: string) => worker.deliver({ tenantId, eventId: id });
    it("sends reminders only to current eligible approvers/delegates and escalation only to group leadership/admins", async () => {
      await owner.approvalDelegation.create({
        data: {
          tenantId,
          approverId: users.manager!.id,
          delegateId: users.delegate!.id,
          startsAt: new Date(Date.now() - 60000),
          endsAt: new Date(Date.now() + 600000),
        },
      });
      let before = received.length;
      const reminder = await event();
      await deliver(reminder.id);
      await deliver(reminder.id);
      expect(
        received
          .slice(before)
          .map((row) => row.to)
          .sort(),
      ).toEqual([users.manager!.email, users.delegate!.email].sort());
      before = received.length;
      const escalation = await event("approval_escalation");
      await deliver(escalation.id);
      expect(
        received
          .slice(before)
          .map((row) => row.to)
          .sort(),
      ).toEqual([users.admin!.email, users.owner!.email].sort());
      expect(JSON.stringify(received)).not.toContain("CONFIDENTIAL-SUMMARY-CANARY");
      expect(JSON.stringify(received)).not.toContain("INTERNAL-BODY-CANARY");
    }, 30000);
    it("suppresses stale calendar/version/stage/authority/responsibility and revoked group leadership", async () => {
      const before = received.length;
      for (const extra of [
        { calendarRevision: 0 },
        { approvalVersion: 2 },
        { stage: "vp" },
        { approvalId: randomUUID() },
      ]) {
        const stale = await event("approval_reminder", extra);
        await deliver(stale.id);
      }
      await owner.user.update({
        where: { id: users.manager!.id },
        data: { approverEligible: false },
      });
      const authority = await event("approval_reminder");
      await deliver(authority.id);
      await owner.user.update({
        where: { id: users.manager!.id },
        data: { approverEligible: true },
      });
      await owner.user.update({ where: { id: users.admin!.id }, data: { active: false } });
      const inactive = await event("approval_escalation");
      await deliver(inactive.id);
      await owner.user.update({ where: { id: users.admin!.id }, data: { active: true } });
      expect(received).toHaveLength(before);
      await owner.membership.deleteMany({ where: { tenantId, userId: users.owner!.id } });
      const revoked = await event("approval_escalation");
      await deliver(revoked.id);
      expect(received.slice(before).map((row) => row.to)).toEqual([users.admin!.email]);
      await owner.membership.create({
        data: { tenantId, departmentId: groupId, userId: users.owner!.id },
      });
    }, 30000);
    it("keeps internal-event notifications with active assigned-group agents even for caller/admin/approver recipients", async () => {
      const before = received.length;
      const note = await owner.outbox.create({
        data: { tenantId, ticketId, event: "incident.message", payload: { audience: "internal" } },
      });
      await deliver(note.id);
      expect(
        received
          .slice(before)
          .map((row) => row.to)
          .sort(),
      ).toEqual([users.owner!.email, users.agent!.email].sort());
    }, 30000);
    it("commits SMTP failure evidence and retries the same event without changing its audience", async () => {
      const { NotificationWorker } =
          await import("../dist/modules/notifications/notifications.service.js"),
        port = process.env.SMTP_PORT;
      process.env.SMTP_PORT = "1";
      const failing = new NotificationWorker(db);
      process.env.SMTP_PORT = port;
      const reminder = await event(),
        before = received.length;
      await expect(failing.deliver({ tenantId, eventId: reminder.id })).rejects.toThrow(
        "SMTP delivery failed",
      );
      const failed = await owner.notificationDelivery.findFirstOrThrow({
        where: { tenantId, eventId: reminder.id, status: "pending" },
      });
      expect(failed.attempts).toBe(1);
      expect(failed.lastError).toBe("SMTP delivery failed");
      await deliver(reminder.id);
      await deliver(reminder.id);
      expect(
        received
          .slice(before)
          .map((row) => row.to)
          .sort(),
      ).toEqual([users.manager!.email, users.delegate!.email].sort());
      expect(
        await owner.notificationDelivery.count({
          where: { tenantId, eventId: reminder.id, status: "pending" },
        }),
      ).toBe(0);
    }, 30000);
    it("reroutes corrections, notifies the destination instead of the old group, preserves sensitive CSV boundaries and alerts administrators on both fallback paths", async () => {
      const { createApp } = await import("../dist/main.js"),
        { tokenHash } = await import("../dist/modules/auth/auth.service.js");
      const destination = await owner.user.create({
        data: {
          tenantId,
          name: "Destination agent",
          email: `destination-${randomUUID()}@test.invalid`,
          role: "agent",
          passwordHash: "!",
          mfaEnrolled: true,
          mfaSecret: "isolated-fixture-secret-not-used",
        },
      });
      const group = await owner.department.create({
        data: { tenantId, name: "Correct destination" },
      });
      await owner.membership.create({
        data: { tenantId, departmentId: group.id, userId: destination.id },
      });
      const category = await owner.category.create({
        data: { tenantId, name: "Correct category", departmentId: group.id, sensitive: false },
      });
      const empty = await owner.department.create({
        data: { tenantId, name: "Unstaffed destination" },
      });
      const fallbackCategory = await owner.category.create({
        data: {
          tenantId,
          name: "Restricted fallback category",
          departmentId: empty.id,
          sensitive: true,
        },
      });
      const fallbackItem = await owner.catalogItem.create({
        data: {
          tenantId,
          categoryId: fallbackCategory.id,
          name: "Fallback request item",
          requiresManager: true,
          currency: "AUD",
        },
      });
      await owner.department.update({ where: { id: groupId }, data: { isTriage: true } });
      await owner.ticket.update({
        where: { id: ticketId },
        data: { assignedToId: users.owner!.id },
      });
      const identity = async (userId: string) => {
        const token = randomUUID(),
          csrf = randomUUID();
        await owner.session.create({
          data: {
            tenantId,
            userId,
            tokenHash: tokenHash(token),
            csrfToken: csrf,
            mfaVerified: true,
            expiresAt: new Date(Date.now() + 600000),
          },
        });
        return {
          cookie: `astrama_session=${token}`,
          "x-csrf-token": csrf,
          origin: process.env.APP_ORIGIN!,
        };
      };
      const oldAgent = await identity(users.owner!.id),
        newAgent = await identity(destination.id),
        app = await createApp();
      try {
        await app.getHttpAdapter().getInstance().ready();
        let ticket = await owner.ticket.findUniqueOrThrow({ where: { id: ticketId } });
        let response = await app.inject({
          method: "POST",
          url: `/api/tickets/${ticketId}/manage`,
          headers: oldAgent,
          payload: {
            revision: ticket.revision,
            action: "category",
            categoryId: category.id,
            reason: "Correct category and responsible group",
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        ticket = await owner.ticket.findUniqueOrThrow({ where: { id: ticketId } });
        expect(ticket.departmentId).toBe(group.id);
        expect(ticket.assignedToId).toBeNull();
        expect(ticket.sensitive).toBe(true);
        const correction = await owner.outbox.findFirstOrThrow({
          where: { tenantId, ticketId, event: "ticket.category" },
          orderBy: { createdAt: "desc" },
        });
        expect(correction.payload).toMatchObject({
          fromDepartmentId: groupId,
          departmentId: group.id,
          routingException: false,
        });
        let before = received.length;
        await deliver(correction.id);
        expect(
          received
            .slice(before)
            .map((row) => row.to)
            .sort(),
        ).toEqual(
          [
            users.caller!.email,
            users.recipient!.email,
            users.manager!.email,
            users.delegate!.email,
            destination.email,
          ].sort(),
        );
        const deniedCsv = await app.inject({
          method: "GET",
          url: "/api/reports/export",
          headers: oldAgent,
        });
        expect(deniedCsv.statusCode).toBe(200);
        expect(deniedCsv.body).not.toContain("SR0001");
        expect(deniedCsv.body).not.toContain("CONFIDENTIAL-SUMMARY-CANARY");
        const allowedCsv = await app.inject({
          method: "GET",
          url: "/api/reports/export",
          headers: newAgent,
        });
        expect(allowedCsv.statusCode).toBe(200);
        expect(allowedCsv.body).toContain("SR0001");
        response = await app.inject({
          method: "POST",
          url: `/api/tickets/${ticketId}/manage`,
          headers: newAgent,
          payload: {
            revision: ticket.revision,
            action: "category",
            categoryId: fallbackCategory.id,
            reason: "Correct to unavailable restricted destination",
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        ticket = await owner.ticket.findUniqueOrThrow({ where: { id: ticketId } });
        expect(ticket.departmentId).toBe(groupId);
        expect(ticket.sensitive).toBe(true);
        const fallback = await owner.outbox.findFirstOrThrow({
          where: { tenantId, ticketId, event: "ticket.category" },
          orderBy: { createdAt: "desc" },
        });
        expect(fallback.payload).toMatchObject({ routingException: true });
        before = received.length;
        await deliver(fallback.id);
        expect(
          received
            .slice(before)
            .map((row) => row.to)
            .sort(),
        ).toEqual(
          [
            users.admin!.email,
            users.owner!.email,
            users.agent!.email,
            users.caller!.email,
            users.recipient!.email,
            users.manager!.email,
            users.delegate!.email,
          ].sort(),
        );
        const alert = received.slice(before).find((row) => row.to === users.admin!.email)!;
        expect(alert.body).toContain("/organisation");
        expect(alert.body).not.toContain("SR0001");
        expect(alert.body).not.toContain("CONFIDENTIAL-SUMMARY-CANARY");
        expect(alert.body).not.toContain("INTERNAL-BODY-CANARY");
        response = await app.inject({
          method: "POST",
          url: `/api/requests/${ticketId}/change`,
          headers: oldAgent,
          payload: {
            revision: ticket.revision,
            itemId: fallbackItem.id,
            requestedForId: users.recipient!.id,
            quantity: 1,
            reason: "Change item with unavailable mapped group",
          },
        });
        expect(response.statusCode, response.body).toBe(201);
        const changed = await owner.outbox.findFirstOrThrow({
          where: { tenantId, ticketId, event: "request.changed" },
          orderBy: { createdAt: "desc" },
        });
        expect(changed.payload).toMatchObject({ routingException: true });
        before = received.length;
        await deliver(changed.id);
        expect(received.slice(before).some((row) => row.to === users.admin!.email)).toBe(true);
        expect((await owner.ticket.findUniqueOrThrow({ where: { id: ticketId } })).sensitive).toBe(
          true,
        );
      } finally {
        await app.close();
      }
    }, 60000);
  },
);
