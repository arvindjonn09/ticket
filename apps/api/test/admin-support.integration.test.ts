import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { hash, argon2id } from "argon2";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { SessionView, TicketDetail } from "@astrama/contracts";
import { totp } from "../src/mfa.js";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);
const password = "Integration-test-password-2026!";
type Identity = { cookie: string; csrf: string; view: SessionView; id: string };
describe.skipIf(!enabled)("group-member admin support access — real PostgreSQL", () => {
  let app: NestFastifyApplication;
  let owner: PrismaClient;
  let runtime: PrismaClient;
  let adminMember: Identity,
    adminNoGroup: Identity,
    employee: Identity,
    agent1: Identity,
    otherTenantAdmin: Identity;
  let tenantId: string;
  let staffedCategoryId: string, triageCategoryId: string, agentOnlyCategoryId: string;
  let staffedGroupId: string,
    triageGroupId: string,
    secondGroupId: string,
    agentOnlyGroupId: string;
  const fixtures: string[] = [];
  const userIds: Record<string, string> = {};
  const origin = process.env.APP_ORIGIN ?? "http://localhost:4310";
  const inject = (
    method: "GET" | "POST",
    url: string,
    identity?: Identity,
    payload?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      remoteAddress:
        "fd00:" + randomUUID().replaceAll("-", "").match(/.{4}/g)!.slice(0, 7).join(":"),
      method,
      url: `/api${url}`,
      headers: {
        origin,
        ...(identity ? { cookie: identity.cookie, "x-csrf-token": identity.csrf } : {}),
        ...extra,
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  async function login(slug: string, email: string): Promise<Identity> {
    const response = await inject("POST", "/auth/login", undefined, {
      organisation: slug,
      email,
      password,
    });
    expect(response.statusCode, response.body).toBe(201);
    const cookies = response.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies[0] : cookies)!.split(";")[0]!;
    const view = response.json<SessionView>();
    return { cookie, csrf: view.csrfToken, view, id: view.user.id };
  }
  async function enrol(identity: Identity) {
    const setup = await inject("POST", "/auth/mfa/setup", identity);
    expect(setup.statusCode, setup.body).toBe(201);
    const verified = await inject("POST", "/auth/mfa/verify", identity, {
      code: totp(setup.json().secret, Math.floor(Date.now() / 30000)),
    });
    expect(verified.statusCode, verified.body).toBe(201);
    identity.view = verified.json();
    identity.csrf = identity.view.csrfToken;
  }
  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.APP_ORIGIN = origin;
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    runtimeUrl.searchParams.set("connection_limit", "1");
    runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString() });
    const passwordHash = await hash(password, { type: argon2id });
    const tenantSlugs: string[] = [];
    for (let i = 0; i < 2; i++) {
      const tenant = await owner.tenant.create({
        data: {
          slug: `integration-${randomUUID()}`,
          name: "Admin support org",
          brandName: "Astrama",
        },
      });
      fixtures.push(tenant.id);
      tenantSlugs.push(tenant.slug);
      if (i === 0) {
        tenantId = tenant.id;
        const staffed = await owner.department.create({
          data: { tenantId: tenant.id, name: "Admin staffed group" },
        });
        staffedGroupId = staffed.id;
        const triage = await owner.department.create({
          data: {
            tenantId: tenant.id,
            name: "Admin triage group",
            isTriage: true,
            queueOwnerId: null,
          },
        });
        triageGroupId = triage.id;
        const second = await owner.department.create({
          data: { tenantId: tenant.id, name: "Second group" },
        });
        secondGroupId = second.id;
        const agentOnly = await owner.department.create({
          data: { tenantId: tenant.id, name: "Agent only group" },
        });
        agentOnlyGroupId = agentOnly.id;
        staffedCategoryId = (
          await owner.category.create({
            data: { tenantId: tenant.id, name: "Admin routed incidents", departmentId: staffed.id },
          })
        ).id;
        triageCategoryId = (
          await owner.category.create({
            data: { tenantId: tenant.id, name: "Triage incidents", departmentId: triage.id },
          })
        ).id;
        agentOnlyCategoryId = (
          await owner.category.create({
            data: { tenantId: tenant.id, name: "Agent only incidents", departmentId: agentOnly.id },
          })
        ).id;
        const users: [string, string, boolean][] = [
          ["admin-member@test.invalid", "admin", true],
          ["admin-nogroup@test.invalid", "admin", false],
          ["employee@test.invalid", "employee", false],
          ["agent1@test.invalid", "agent", true],
        ];
        for (const [email, role, member] of users) {
          const user = await owner.user.create({
            data: { tenantId: tenant.id, email, role, name: email.split("@")[0]!, passwordHash },
          });
          userIds[email.split("@")[0]!] = user.id;
          if (member)
            for (const departmentId of [staffed.id, triage.id, second.id, agentOnly.id])
              await owner.membership.create({
                data: { tenantId: tenant.id, userId: user.id, departmentId },
              });
        }
        // The member admin must not belong to the agent-only group for the SLA regression test
        await owner.membership.delete({
          where: {
            tenantId_userId_departmentId: {
              tenantId: tenant.id,
              userId: userIds["admin-member"],
              departmentId: agentOnly.id,
            },
          },
        });
        await owner.department.update({
          where: { id: staffed.id },
          data: { queueOwnerId: userIds["admin-member"] },
        });
        await owner.department.update({
          where: { id: second.id },
          data: { queueOwnerId: userIds["admin-member"] },
        });
      } else {
        void tenant.id;
        const admin = await owner.user.create({
          data: {
            tenantId: tenant.id,
            email: "other-admin@test.invalid",
            role: "admin",
            name: "other-admin",
            passwordHash,
          },
        });
        userIds["other-admin"] = admin.id;
      }
    }
    const { createApp } = await import("../dist/main.js");
    app = await createApp();
    await app.getHttpAdapter().getInstance().ready();
    adminMember = await login(tenantSlugs[0]!, "admin-member@test.invalid");
    adminNoGroup = await login(tenantSlugs[0]!, "admin-nogroup@test.invalid");
    employee = await login(tenantSlugs[0]!, "employee@test.invalid");
    agent1 = await login(tenantSlugs[0]!, "agent1@test.invalid");
    otherTenantAdmin = await login(tenantSlugs[1]!, "other-admin@test.invalid");
    for (const identity of [adminMember, adminNoGroup, agent1, otherTenantAdmin])
      await enrol(identity);
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await runtime?.$disconnect();
    if (owner) {
      // Fixtures are named, isolated tenants; never truncate shared demo data.
      for (const id of fixtures) {
        for (const table of [
          "notification_deliveries",
          "idempotency",
          "outbox",
          "audits",
          "config_audits",
          "activities",
          "tickets",
          "sessions",
          "memberships",
          "categories",
          "counters",
          "departments",
          "users",
          "tenants",
        ]) {
          await owner.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}" = $1::uuid`,
            id,
          );
        }
      }
      await owner.$disconnect();
    }
  });
  async function createIncident(
    identity: Identity,
    categoryId: string,
    body: Partial<{ callerId: string; channel: string; summary: string; description: string }> = {},
  ): Promise<{ status: number; json: () => TicketDetail & { message?: string } }> {
    const response = await inject(
      "POST",
      "/tickets",
      identity,
      {
        categoryId,
        summary: "Admin support integration incident",
        description: "Raised by the group-member admin integration test.",
        ...body,
      },
      { "idempotency-key": randomUUID() },
    );
    return { status: response.statusCode, json: () => response.json() };
  }
  it("lets a group-member admin submit on behalf, claim, note internally, assign, transfer, and resolve", async () => {
    const created = await createIncident(adminMember, staffedCategoryId, {
      callerId: employee.id,
      channel: "Phone",
    });
    expect(created.status, JSON.stringify(created.json())).toBe(201);
    const ticket = created.json();
    expect(ticket.departmentId).toBe(staffedGroupId);
    expect(ticket.untriaged).toBe(true);
    expect(ticket.channel).toBe("Phone");
    expect(ticket.callerId).toBe(employee.id);
    // Claim as member admin
    const claimed = await inject("POST", `/tickets/${ticket.id}/claim`, adminMember, {
      revision: ticket.revision,
    });
    expect(claimed.statusCode, claimed.body).toBe(201);
    expect(claimed.json().assignedToId).toBe(adminMember.id);
    // Internal note visible only to group staff
    const note = await inject("POST", `/tickets/${ticket.id}/messages`, adminMember, {
      revision: claimed.json().revision,
      body: "Internal: admin handled like an agent",
      audience: "internal",
    });
    expect(note.statusCode, note.body).toBe(201);
    const asAgent = await inject("GET", `/tickets/${ticket.id}`, agent1);
    expect(
      asAgent.json().activities.some((a: { audience: string }) => a.audience === "internal"),
    ).toBe(true);
    const asEmployee = await inject("GET", `/tickets/${ticket.id}`, employee);
    expect(
      asEmployee.json().activities.some((a: { audience: string }) => a.audience === "internal"),
    ).toBe(false);
    // Assignment options and assignment as queue-owner admin
    const options = await inject("GET", `/tickets/${ticket.id}/assignment-options`, adminMember);
    expect(options.statusCode, options.body).toBe(200);
    expect(options.json().users.map((u: { id: string }) => u.id)).toContain(userIds["agent1"]);
    const assigned = await inject("POST", `/tickets/${ticket.id}/manage`, adminMember, {
      action: "assign",
      revision: note.json().revision,
      reason: "Route to group agent",
      assignedToId: userIds["agent1"],
    });
    expect(assigned.statusCode, assigned.body).toBe(201);
    expect(assigned.json().assignedToId).toBe(userIds["agent1"]);
    // Member admin customer message counts as the SLA first response
    const customer = await inject("POST", `/tickets/${ticket.id}/messages`, adminMember, {
      revision: assigned.json().revision,
      body: "We are working on your incident",
      audience: "customer",
    });
    expect(customer.statusCode, customer.body).toBe(201);
    expect(customer.json().slaFirstRespondedAt).toBeTruthy();
    // Transfer to second group where the member admin also belongs
    const transfer = await inject("POST", `/tickets/${ticket.id}/manage`, adminMember, {
      action: "transfer",
      revision: customer.json().revision,
      reason: "Move to second group",
      departmentId: secondGroupId,
    });
    expect(transfer.statusCode, transfer.body).toBe(201);
    // Unassign as queue owner of the destination, claim again and resolve
    const unassign = await inject("POST", `/tickets/${ticket.id}/manage`, adminMember, {
      action: "assign",
      revision: transfer.json().revision,
      reason: "Release for claim",
      assignedToId: null,
    });
    expect(unassign.statusCode, unassign.body).toBe(201);
    const claim2 = await inject("POST", `/tickets/${ticket.id}/claim`, adminMember, {
      revision: unassign.json().revision,
    });
    expect(claim2.statusCode, claim2.body).toBe(201);
    const started = await inject("POST", `/tickets/${ticket.id}/state`, adminMember, {
      state: "In Progress",
      revision: claim2.json().revision,
    });
    expect(started.statusCode, started.body).toBe(201);
    const resolved = await inject("POST", `/tickets/${ticket.id}/state`, adminMember, {
      state: "Resolved",
      revision: started.json().revision,
      resolution: "Fixed by member admin",
      customerSummary: "We fixed your issue",
    });
    expect(resolved.statusCode, resolved.body).toBe(201);
    expect(resolved.json().state).toBe("Resolved");
    expect(resolved.json().slaFirstRespondedAt).toBeTruthy();
    const released = await inject("POST", `/tickets/${ticket.id}/manage`, adminMember, {
      action: "assign",
      revision: resolved.json().revision,
      reason: "Release assignment after resolution",
      assignedToId: null,
    });
    expect(released.statusCode, released.body).toBe(201);
  });
  it("routes incidents to an active group containing a member administrator", async () => {
    const created = await createIncident(agent1, staffedCategoryId);
    expect(created.status).toBe(201);
    expect(created.json().departmentId).toBe(staffedGroupId);
    expect(created.json().untriaged).toBe(true);
  });
  it("does not count an unrelated-group admin's own customer reply as SLA first response", async () => {
    // Submitted on behalf of the employee; the ticket lands in a group the admin does not belong to
    const created = await createIncident(adminMember, agentOnlyCategoryId, {
      summary: `Unrelated response ${randomUUID()}`,
      callerId: employee.id,
      channel: "Phone",
    });
    expect(created.status, JSON.stringify(created.json())).toBe(201);
    expect(created.json().departmentId).toBe(agentOnlyGroupId);
    const ticketId = created.json().id;
    // The submitting admin is the submittedBy participant, but is not group staff here
    const reply = await inject("POST", `/tickets/${ticketId}/messages`, adminMember, {
      revision: created.json().revision,
      body: "Caller reply, not a support first response",
      audience: "customer",
    });
    expect(reply.statusCode, reply.body).toBe(201);
    expect(reply.json().slaFirstRespondedAt).toBeNull();
    const report = await inject(
      "GET",
      `/reports/summary?search=${encodeURIComponent(created.json().summary)}`,
      adminMember,
    );
    expect(report.statusCode, report.body).toBe(200);
    expect(report.json().total).toBe(1);
    expect(report.json().medianFirstResponseHours).toBeNull();
    // A group agent's customer reply counts
    const staffReply = await inject("POST", `/tickets/${ticketId}/messages`, agent1, {
      revision: reply.json().revision,
      body: "Support first response",
      audience: "customer",
    });
    expect(staffReply.statusCode, staffReply.body).toBe(201);
    expect(staffReply.json().slaFirstRespondedAt).toBeTruthy();
  });
  it("denies a nonmember admin support actions, assisted submission and sensitive/department visibility", async () => {
    const created = await createIncident(employee, triageCategoryId, {
      channel: "Self Service",
    });
    expect(created.status).toBe(201);
    const ticketId = created.json().id;
    // Not in their list, not readable, no claim
    const list = await inject("GET", `/tickets?scope=all`, adminNoGroup);
    expect(list.statusCode).toBe(200);
    expect(list.json().tickets.some((t: { id: string }) => t.id === ticketId)).toBe(false);
    expect((await inject("GET", `/tickets/${ticketId}`, adminNoGroup)).statusCode).toBe(404);
    expect(
      (await inject("POST", `/tickets/${ticketId}/claim`, adminNoGroup, { revision: 0 }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await inject("POST", `/tickets/${ticketId}/messages`, adminNoGroup, {
          revision: 0,
          body: "nope",
          audience: "internal",
        })
      ).statusCode,
    ).toBe(404);
    // No assisted channels or on-behalf submission
    const assisted = await createIncident(adminNoGroup, staffedCategoryId, { channel: "Phone" });
    expect(assisted.status).toBe(403);
    const onBehalf = await createIncident(adminNoGroup, staffedCategoryId, {
      channel: "Self Service",
      callerId: employee.id,
    });
    expect(onBehalf.status).toBe(403);
    // Config access still works (MFA-verified admin)
    const config = await inject("GET", "/admin/config", adminNoGroup);
    expect(config.statusCode, config.body).toBe(200);
    expect(config.json().agents.some((u: { id: string }) => u.id === adminMember.id)).toBe(true);
  });
  it("denies employees and other-tenant administrators", async () => {
    const created = await createIncident(employee, triageCategoryId);
    expect(created.status).toBe(201);
    const ticketId = created.json().id;
    const claim = await inject("POST", `/tickets/${ticketId}/claim`, employee, {
      revision: created.json().revision,
    });
    expect([403, 404]).toContain(claim.statusCode);
    const note = await inject("POST", `/tickets/${ticketId}/messages`, employee, {
      revision: created.json().revision,
      body: "employee internal note",
      audience: "internal",
    });
    expect(note.statusCode).toBe(403);
    // Cross-tenant admin: not found, never readable
    expect((await inject("GET", `/tickets/${ticketId}`, otherTenantAdmin)).statusCode).toBe(404);
    const cross = await createIncident(otherTenantAdmin, staffedCategoryId);
    expect(cross.status).toBe(400);
  });
  it("protects membership lifecycle: admin edits keep memberships; last staffed triage member demotion is denied", async () => {
    const config = await inject("GET", "/admin/config", adminNoGroup);
    const groups = config.json().groups as {
      id: string;
      name: string;
      revision: number;
      queueOwnerId: string | null;
      substituteId: string | null;
    }[];
    const save = (group: (typeof groups)[number], memberIds: string[]) =>
      inject("POST", `/admin/groups/${group.id}`, adminMember, {
        name: group.name,
        active: true,
        revision: group.revision,
        queueOwnerId: null,
        substituteId: null,
        memberIds,
      });
    // Clear queue ownership and drop the agent from triage so the member admin is the last staffed member
    for (const group of groups.filter((group) => group.id !== agentOnlyGroupId)) {
      const saved = await save(
        group,
        group.id === triageGroupId ? [adminMember.id] : [adminMember.id, userIds["agent1"]],
      );
      expect(saved.statusCode, saved.body).toBe(201);
    }
    // Demoting the last staffed triage member is denied
    const user = (await inject("GET", `/users/${adminMember.id}`, adminMember)).json();
    const demote = await inject("POST", `/admin/users/${adminMember.id}`, adminNoGroup, {
      name: user.name,
      email: user.email,
      role: "employee",
      approverEligible: false,
      isVp: false,
      managerId: null,
      homeDepartment: "",
      phone: "",
      jobTitle: "",
      active: true,
      revision: user.revision,
    });
    expect(demote.statusCode, demote.body).toBe(409);
    expect(String(demote.json().message)).toContain("Triage must retain an active");
    // A pure profile edit keeps role, access and memberships
    const edit = await inject("POST", `/admin/users/${adminMember.id}`, adminNoGroup, {
      name: "Renamed member admin",
      email: user.email,
      role: "admin",
      approverEligible: false,
      isVp: false,
      managerId: null,
      homeDepartment: "",
      phone: "",
      jobTitle: "",
      active: true,
      revision: user.revision,
    });
    expect(edit.statusCode, edit.body).toBe(201);
    const memberships = await owner.membership.findMany({
      where: { tenantId, userId: adminMember.id },
    });
    expect(memberships.map((m) => m.departmentId).sort()).toEqual(
      [staffedGroupId, triageGroupId, secondGroupId].sort(),
    );
    // A different active administrator can be added to the group.
    const fresh = await inject("GET", "/admin/config", adminNoGroup);
    const staffedGroup = fresh.json().groups.find((g: { id: string }) => g.id === staffedGroupId);
    const withNonmember = await inject("POST", `/admin/groups/${staffedGroupId}`, adminMember, {
      name: staffedGroup.name,
      active: true,
      revision: staffedGroup.revision,
      queueOwnerId: null,
      substituteId: null,
      memberIds: [adminNoGroup.id],
    });
    expect(withNonmember.statusCode, withNonmember.body).toBe(201);
    expect(
      await owner.membership.count({
        where: { tenantId, departmentId: staffedGroupId, userId: adminNoGroup.id },
      }),
    ).toBe(1);
  });
});
