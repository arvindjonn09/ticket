import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

const enabled = Boolean(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL);

type Metadata = {
  id: string;
  slug: string;
  status: string;
  active: boolean;
  seatsUsed: number;
  createdAt: string | null;
  lastActivity: string | null;
  adminContacts?: { email: string; mfaEnrolled: boolean }[];
  health?: Record<string, unknown>;
  timeline?: { action: string; at: string }[];
};

async function sqlState(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    return (error as { meta?: { code?: string } }).meta?.code;
  }
  throw new Error("expected the statement to fail");
}

describe.skipIf(!enabled)("operator identity and metadata foundation on PostgreSQL", () => {
  let owner: PrismaClient;
  let runtime: PrismaClient;
  const fixture = randomUUID();
  const tenantIds: string[] = [];
  const secrets = {
    ticket: `TOP-SECRET-TICKET-${fixture}`,
    activity: `SECRET-ACTIVITY-${fixture}`,
    audit: `SECRET-AUDIT-${fixture}`,
    config: `SECRET-CONFIG-${fixture}`,
    outbox: `SECRET-OUTBOX-${fixture}`,
    inbound: `SECRET-INBOUND-${fixture}`,
    attachment: `secret-attachment-${fixture}.txt`,
    mfa: `SECRET-MFA-${fixture}`,
    operator: `SECRET-OPERATOR-DETAIL-${fixture}`,
  };
  let operatorId = "";
  let inactiveOperatorId = "";
  let auditId = "";
  let tenantA = "";
  let tenantB = "";

  async function tenantFixture(label: string, ticketSecret: string) {
    const tenant = await owner.tenant.create({
      data: {
        slug: `ops-${label}-${fixture.slice(0, 8)}`,
        name: `Ops ${label}`,
        brandName: `Ops ${label}`,
      },
    });
    tenantIds.push(tenant.id);
    const admin = await owner.user.create({
      data: {
        tenantId: tenant.id,
        name: `${label} admin`,
        email: `${label}-admin-${fixture}@test.invalid`,
        passwordHash: "not-a-login-hash",
        role: "admin",
        mfaEnrolled: label === "a",
        mfaSecret: label === "a" ? secrets.mfa : null,
      },
    });
    const employee = await owner.user.create({
      data: {
        tenantId: tenant.id,
        name: `${label} employee`,
        email: `${label}-employee-${fixture}@test.invalid`,
        passwordHash: "not-a-login-hash",
        role: "employee",
      },
    });
    const department = await owner.department.create({
      data: { tenantId: tenant.id, name: `${label} triage`, isTriage: true },
    });
    const category = await owner.category.create({
      data: { tenantId: tenant.id, name: `${label} category`, departmentId: department.id },
    });
    const ticket = await owner.ticket.create({
      data: {
        tenantId: tenant.id,
        type: "incident",
        sequence: 1,
        number: "INC0001",
        summary: `Fixture ${label}`,
        description: ticketSecret,
        priority: "P3",
        severity: "S3",
        categoryId: category.id,
        departmentId: department.id,
        callerId: employee.id,
        submittedById: employee.id,
      },
    });
    return { tenant, admin, employee, department, category, ticket };
  }

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    const runtimeUrl = new URL(process.env.DATABASE_URL!);
    runtimeUrl.searchParams.set("connection_limit", "1");
    runtime = new PrismaClient({ datasourceUrl: runtimeUrl.toString() });

    const a = await tenantFixture("a", secrets.ticket);
    tenantA = a.tenant.id;
    const b = await tenantFixture("b", `SECRET-TENANT-B-${fixture}`);
    tenantB = b.tenant.id;
    await owner.user.createMany({
      data: [
        {
          tenantId: tenantA,
          name: "Reserved invitation",
          email: `reserved-${fixture}@test.invalid`,
          role: "employee",
          active: false,
          passwordHash: "!",
          invitationHash: `reserved-${fixture}`,
          invitationExpiresAt: new Date(Date.now() + 3600000),
        },
        {
          tenantId: tenantA,
          name: "Expired invitation",
          email: `expired-${fixture}@test.invalid`,
          role: "employee",
          active: false,
          passwordHash: "!",
          invitationHash: `expired-${fixture}`,
          invitationExpiresAt: new Date(Date.now() - 3600000),
        },
        {
          tenantId: tenantA,
          name: "System intake",
          email: `system-${fixture}@test.invalid`,
          role: "system",
          active: true,
          passwordHash: "!",
        },
      ],
    });

    await owner.activity.create({
      data: {
        tenantId: a.tenant.id,
        ticketId: a.ticket.id,
        authorId: a.admin.id,
        audience: "internal",
        body: secrets.activity,
      },
    });
    await owner.audit.create({
      data: {
        tenantId: a.tenant.id,
        ticketId: a.ticket.id,
        actorId: a.admin.id,
        action: "ticket.updated",
        detail: { secret: secrets.audit },
      },
    });
    await owner.configAudit.create({
      data: {
        tenantId: a.tenant.id,
        actorId: a.admin.id,
        entityId: a.category.id,
        action: "category.updated",
        detail: { secret: secrets.config },
      },
    });
    await owner.outbox.create({
      data: {
        tenantId: a.tenant.id,
        ticketId: a.ticket.id,
        event: "ticket.updated",
        payload: { secret: secrets.outbox },
      },
    });
    await owner.attachment.create({
      data: {
        tenantId: a.tenant.id,
        ticketId: a.ticket.id,
        authorId: a.admin.id,
        filename: secrets.attachment,
        contentType: "text/plain",
        size: 1234,
        audience: "internal",
        storageKey: `fixture-${fixture}`,
        status: "clean",
      },
    });
    await owner.inboundMessage.create({
      data: {
        tenantId: a.tenant.id,
        messageId: `fixture-${fixture}`,
        recipient: "support@test.invalid",
        senderEmail: "sender@test.invalid",
        subject: secrets.inbound,
        textBody: secrets.inbound,
        authResults: {},
        status: "queued",
      },
    });
    await owner.invitationMail.create({
      data: {
        tenantId: a.tenant.id,
        userId: a.employee.id,
        invitationHash: `invite-${fixture}`,
        status: "sent",
        sentAt: new Date(),
      },
    });

    const operator = await owner.operator.create({
      data: {
        name: "Ops owner",
        email: `ops-owner-${fixture}@operator.invalid`,
        passwordHash: "not-a-login-hash",
        role: "owner",
      },
    });
    operatorId = operator.id;
    await owner.operatorSupportGrant.create({
      data: {
        tenantId: tenantA,
        operatorId,
        grantedById: a.admin.id,
        reason: "Fixture support permission",
        expiresAt: new Date(Date.now() + 3600000),
      },
    });
    const inactive = await owner.operator.create({
      data: {
        name: "Ops inactive",
        email: `ops-inactive-${fixture}@operator.invalid`,
        passwordHash: "not-a-login-hash",
        role: "support",
        active: false,
      },
    });
    inactiveOperatorId = inactive.id;
    const audit = await owner.operatorAudit.create({
      data: {
        operatorId,
        tenantId: a.tenant.id,
        tenantSlug: a.tenant.slug,
        action: "operator.organisation.viewed",
        reason: "fixture",
        detail: { secret: secrets.operator, summary: "not exposed" },
      },
    });
    auditId = audit.id;
  });

  afterAll(async () => {
    if (owner) {
      for (const tenantId of tenantIds) {
        await owner.operatorSupportGrant.deleteMany({ where: { tenantId } });
        await owner.notificationDelivery.deleteMany({ where: { tenantId } });
        await owner.outbox.deleteMany({ where: { tenantId } });
        await owner.attachment.deleteMany({ where: { tenantId } });
        await owner.inboundMessage.deleteMany({ where: { tenantId } });
        await owner.invitationMail.deleteMany({ where: { tenantId } });
        await owner.audit.deleteMany({ where: { tenantId } });
        await owner.activity.deleteMany({ where: { tenantId } });
        await owner.configAudit.deleteMany({ where: { tenantId } });
        await owner.ticket.deleteMany({ where: { tenantId } });
        await owner.category.deleteMany({ where: { tenantId } });
        await owner.department.deleteMany({ where: { tenantId } });
        await owner.user.deleteMany({ where: { tenantId } });
        // Audit rows are append-only and intentionally retained, as in existing audit tests.
        await owner.tenant.delete({ where: { id: tenantId } });
      }
      await owner.$disconnect();
    }
    await runtime?.$disconnect();
  });

  it("returns organisation metadata without ticket content and validates the operator", async () => {
    const [row] = await runtime.$queryRaw<{ data: Metadata[] }[]>`
      SELECT public.operator_organisation_metadata(${operatorId}::uuid,'',NULL) AS data`;
    const list = row!.data;
    expect(Array.isArray(list)).toBe(true);
    const a = list.find((item) => item.id === tenantA)!;
    expect(a).toBeDefined();
    expect(a).toMatchObject({
      slug: expect.stringContaining("ops-a-"),
      status: "active",
      active: true,
      planId: null,
      seatLimit: 100000,
      seatsUsed: 3,
    });
    expect(a.createdAt).not.toBeNull();
    expect(a.lastActivity).not.toBeNull();
    expect(a.adminContacts).toBeUndefined();
    expect(a.health).toBeUndefined();
    expect(list.some((item) => item.id === tenantB)).toBe(true);
    expect(list.map((item) => item.slug)).toEqual([...list.map((item) => item.slug)].sort());

    const serialised = JSON.stringify(list);
    for (const secret of Object.values(secrets)) expect(serialised).not.toContain(secret);

    const [searchRow] = await runtime.$queryRaw<{ data: Metadata[] }[]>`
      SELECT public.operator_organisation_metadata(${operatorId}::uuid,${`ops-a-${fixture.slice(0, 8)}`},NULL) AS data`;
    expect(searchRow!.data.map((item) => item.id)).toEqual([tenantA]);
  });

  it("returns admin contacts, health counts and an action-only timeline for one organisation", async () => {
    const [row] = await runtime.$queryRaw<{ data: Metadata[] }[]>`
      SELECT public.operator_organisation_metadata(${operatorId}::uuid,'',${tenantA}::uuid) AS data`;
    const list = row!.data;
    expect(list).toHaveLength(1);
    const detail = list[0]!;
    expect(detail.adminContacts?.map((contact) => contact.email)).toEqual([
      expect.stringContaining("a-admin-"),
    ]);
    expect(detail.adminContacts?.[0]).toMatchObject({ mfaEnrolled: true });
    expect(detail.health).toMatchObject({
      outboxBacklog: 1,
      failedJobs: 0,
      inboundQueue: 1,
      storageBytes: 1234,
    });
    expect(detail.health?.lastEmailDelivered).not.toBeNull();
    expect(detail.timeline?.map((event) => event.action)).toEqual(
      expect.arrayContaining(["status:active", "category.updated", "operator.organisation.viewed"]),
    );
    const serialised = JSON.stringify(detail);
    for (const secret of Object.values(secrets)) expect(serialised).not.toContain(secret);
    expect(serialised).not.toContain("a-employee-");
  });

  it("denies unknown or inactive operators with SQLSTATE 42501", async () => {
    expect(
      await sqlState(
        runtime.$queryRaw`SELECT public.operator_organisation_metadata(${inactiveOperatorId}::uuid)`,
      ),
    ).toBe("42501");
    expect(
      await sqlState(
        runtime.$queryRaw`SELECT public.operator_organisation_metadata(${randomUUID()}::uuid)`,
      ),
    ).toBe("42501");
  });

  it("keeps ticket rows behind tenant RLS and operator audits append-only", async () => {
    const [withoutContext] = await runtime.$queryRaw<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM public.tickets`;
    expect(withoutContext!.count).toBe(0);

    await runtime.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantA}, true)`;
      const [own] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM public.tickets`;
      expect(own!.count).toBe(1);
      const [cross] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM public.tickets WHERE tenant_id=${tenantB}::uuid`;
      expect(cross!.count).toBe(0);
    });
    const [grantsWithoutContext] = await runtime.$queryRaw<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM operator_support_grants`;
    expect(grantsWithoutContext!.count).toBe(0);

    await expect(
      owner.$executeRaw`UPDATE public.operator_audits SET action='tampered' WHERE id=${auditId}::uuid`,
    ).rejects.toThrow();
    await expect(
      owner.$executeRaw`DELETE FROM public.operator_audits WHERE id=${auditId}::uuid`,
    ).rejects.toThrow();
  });
});
