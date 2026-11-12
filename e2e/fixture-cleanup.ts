import type { Database } from "../apps/api/src/database.js";

/** Deletes only the explicit random fixture identity, serialized with live workers. */
export async function cleanupFixture(
  owner: Pick<Database, "$transaction">,
  tenantId: string,
  expectedSlug: string,
) {
  if (!/^(browser|complete|recover-browser)-[0-9a-f-]{36}$/.test(expectedSlug))
    throw new Error("Refusing a shared organisation cleanup");
  await owner.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`configuration:${tenantId}`},0))`;
      const tenant = await tx.tenant.findFirst({ where: { id: tenantId, slug: expectedSlug } });
      if (!tenant) throw new Error("Fixture tenant identity changed");
      await tx.ticket.updateMany({ where: { tenantId }, data: { duplicateOfId: null } });
      await tx.department.updateMany({
        where: { tenantId },
        data: { queueOwnerId: null, substituteId: null },
      });
      await tx.user.updateMany({ where: { tenantId }, data: { managerId: null } });
      for (const table of [
        "automation_actions",
        "automation_settings",
        "invitation_mails",
        "notification_deliveries",
        "attachments",
        "approvals",
        "approval_delegations",
        "idempotency",
        "outbox",
        "audits",
        "activities",
        "tickets",
        "catalog_items",
        "config_audits",
        "sessions",
        "memberships",
        "subcategories",
        "categories",
        "counters",
        "departments",
        "users",
        "tenants",
      ]) {
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE "${table === "tenants" ? "id" : "tenant_id"}"=$1::uuid`,
          tenantId,
        );
      }
    },
    { maxWait: 15000, timeout: 30000 },
  );
}
