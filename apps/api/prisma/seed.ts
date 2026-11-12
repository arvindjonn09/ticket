import { PrismaClient } from "@prisma/client";
import { hash, argon2id } from "argon2";

if (
  !process.env.MIGRATION_DATABASE_URL ||
  !process.env.DEMO_PASSWORD ||
  process.env.NODE_ENV !== "development"
)
  throw new Error(
    "Demo seed requires NODE_ENV=development, MIGRATION_DATABASE_URL and DEMO_PASSWORD",
  );
if (process.env.DEMO_PASSWORD.length < 12)
  throw new Error("Demo password must have at least 12 characters");
const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
try {
  const passwordHash = await hash(process.env.DEMO_PASSWORD, { type: argon2id });
  for (const [slug, name] of [
    ["harbour", "Harbour Services"],
    ["northstar", "Northstar Labs"],
  ]) {
    const tenant = await db.tenant.upsert({
      where: { slug },
      create: { slug, name, brandName: "Astrama" },
      update: {},
    });
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
      await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: "admin@demo.test" } },
        create: {
          tenantId: tenant.id,
          email: "admin@demo.test",
          name: "Organisation Administrator",
          role: "admin",
          passwordHash,
        },
        update: { passwordHash },
      });
      const employee = await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: "employee@demo.test" } },
        create: {
          tenantId: tenant.id,
          email: "employee@demo.test",
          name: "Alex Morgan",
          role: "employee",
          passwordHash,
        },
        update: { passwordHash },
      });
      const agent = await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: "agent@demo.test" } },
        create: {
          tenantId: tenant.id,
          email: "agent@demo.test",
          name: "Sam Taylor",
          role: "agent",
          passwordHash,
        },
        update: { passwordHash },
      });
      const outsider = await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: "colleague@demo.test" } },
        create: {
          tenantId: tenant.id,
          email: "colleague@demo.test",
          name: "Jordan Lee",
          role: "employee",
          passwordHash,
        },
        update: { passwordHash },
      });
      const manager = await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: "manager@demo.test" } },
        create: {
          tenantId: tenant.id,
          email: "manager@demo.test",
          name: "Demo Manager",
          role: "employee",
          approverEligible: true,
          passwordHash,
        },
        update: { passwordHash },
      });
      const vp = await tx.user.upsert({
        where: { tenantId_email: { tenantId: tenant.id, email: "vp@demo.test" } },
        create: {
          tenantId: tenant.id,
          email: "vp@demo.test",
          name: "Demo VP",
          role: "employee",
          approverEligible: true,
          isVp: true,
          passwordHash,
        },
        update: { passwordHash },
      });
      const departments = [];
      for (const departmentName of [
        "IT Support",
        "Application Support",
        "Infrastructure",
        "Security",
        "Service Desk Triage",
      ]) {
        const department = await tx.department.upsert({
          where: { tenantId_name: { tenantId: tenant.id, name: departmentName } },
          create: {
            tenantId: tenant.id,
            name: departmentName,
            isTriage: departmentName === "Service Desk Triage",
          },
          update: {},
        });
        departments.push(department);
        await tx.membership.upsert({
          where: {
            tenantId_userId_departmentId: {
              tenantId: tenant.id,
              userId: agent.id,
              departmentId: department.id,
            },
          },
          create: { tenantId: tenant.id, userId: agent.id, departmentId: department.id },
          update: {},
        });
      }
      const categories = [];
      for (const [index, categoryName] of [
        "Devices & workplace",
        "Business applications",
        "Network & access",
        "Security concern",
      ].entries()) {
        categories.push(
          await tx.category.upsert({
            where: { tenantId_name: { tenantId: tenant.id, name: categoryName } },
            create: {
              tenantId: tenant.id,
              name: categoryName,
              departmentId: departments[index]!.id,
              sensitive: index === 3,
            },
            update: {},
          }),
        );
      }
      await tx.category.upsert({
        where: { tenantId_name: { tenantId: tenant.id, name: "Not sure / General help" } },
        create: {
          tenantId: tenant.id,
          name: "Not sure / General help",
          departmentId: departments[4]!.id,
        },
        update: {},
      });
      for (const item of [
        {
          name: "Demo application access",
          categoryId: categories[1]!.id,
          unitCostMinor: 0,
          requiresVp: false,
        },
        {
          name: "Demo equipment request",
          categoryId: categories[0]!.id,
          unitCostMinor: 150000,
          requiresVp: true,
        },
      ])
        await tx.catalogItem.upsert({
          where: { tenantId_name: { tenantId: tenant.id, name: item.name } },
          create: {
            tenantId: tenant.id,
            ...item,
            currency: "AUD",
            requiresManager: true,
            alternateApproverId: manager.id,
            vpApproverId: vp.id,
          },
          update: {},
        });
      await tx.counter.upsert({
        where: { tenantId_type: { tenantId: tenant.id, type: "incident" } },
        create: { tenantId: tenant.id, type: "incident" },
        update: {},
      });
      if ((await tx.ticket.count({ where: { tenantId: tenant.id } })) === 0) {
        const examples = [
          [
            "Laptop loses connection after sleep",
            "My laptop disconnects from the office network whenever it wakes from sleep.",
            "Open",
            "P3",
          ],
          [
            "Timesheet application will not load",
            "The timesheet application shows a blank screen after I sign in this morning.",
            "In Progress",
            "P2",
          ],
          [
            "VPN connection drops during calls",
            "The remote access connection disconnects several times during video meetings.",
            "Open",
            "P3",
          ],
          [
            "Unexpected sign-in notification",
            "I received a sign-in notification from a device I do not recognise.",
            "In Progress",
            "P2",
          ],
          [
            "Meeting room display flickers",
            "The display in the meeting room flickers when connected to a laptop.",
            "Resolved",
            "P4",
          ],
          [
            "Reporting dashboard access restored",
            "The reporting dashboard previously showed an access denied error on opening.",
            "Complete",
            "P4",
          ],
        ];
        for (const [i, example] of examples.entries()) {
          const category = categories[i % categories.length]!;
          const counter = await tx.counter.update({
            where: { tenantId_type: { tenantId: tenant.id, type: "incident" } },
            data: { sequence: { increment: 1 } },
          });
          const createdAt = new Date(Date.now() - (i + 1) * 86400000);
          const ticket = await tx.ticket.create({
            data: {
              tenantId: tenant.id,
              sequence: counter.sequence,
              number: `${tenant.incidentPrefix}${String(counter.sequence).padStart(4, "0")}`,
              summary: example[0]!,
              description: example[1]!,
              state: example[2]!,
              priority: example[3]!,
              severity: tenant.defaultSeverity,
              categoryId: category.id,
              departmentId: category.departmentId,
              sensitive: category.sensitive,
              callerId: i === 5 ? outsider.id : employee.id,
              assignedToId: i % 2 || i === 4 ? agent.id : null,
              createdAt,
              updatedAt: new Date(createdAt.getTime() + 3600000),
            },
          });
          await tx.activity.create({
            data: {
              tenantId: tenant.id,
              ticketId: ticket.id,
              authorId: agent.id,
              body:
                i === 4
                  ? "The display cable has been replaced. Please confirm the screen is working."
                  : "We have received your incident and are reviewing it.",
              audience: "customer",
              createdAt,
            },
          });
          await tx.activity.create({
            data: {
              tenantId: tenant.id,
              ticketId: ticket.id,
              authorId: agent.id,
              body: "Internal diagnostic work recorded for the support team.",
              audience: "internal",
              createdAt,
            },
          });
          const audit = await tx.audit.create({
            data: {
              tenantId: tenant.id,
              ticketId: ticket.id,
              actorId: employee.id,
              action: "incident.seeded",
              detail: { demo: true },
            },
          });
          await tx.outbox.create({
            data: {
              tenantId: tenant.id,
              ticketId: ticket.id,
              event: "incident.seeded",
              payload: { auditId: audit.id },
            },
          });
        }
      }
    });
  }
  console.info("Demo organisations and accounts provisioned.");
} finally {
  await db.$disconnect();
}
