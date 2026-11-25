import type { Tx } from "./database.js";
import { createHash } from "node:crypto";
import { platformInboundAddress } from "./platform-mail.js";

/** Bind the platform alias to an existing configured route or the unambiguous starter triage route. */
export async function ensurePlatformInbox(tx: Tx, tenantId: string, actorId: string) {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const address = platformInboundAddress(tenant.slug);
  if (!address) return;
  let settings = await tx.inboundMailSettings.findUnique({ where: { tenantId } });
  if (!settings && tenant.starterTemplateVersion) {
    const departments = await tx.department.findMany({
      where: { tenantId, active: true, isTriage: true },
    });
    if (departments.length !== 1 || !departments[0]!.queueOwnerId) return;
    const categories = await tx.category.findMany({
      where: {
        tenantId,
        departmentId: departments[0]!.id,
        active: true,
        sensitive: false,
        allowIncidents: true,
      },
    });
    if (categories.length !== 1) return;
    settings = await tx.inboundMailSettings.upsert({
      where: { tenantId },
      update: {},
      create: {
        tenantId,
        triageDepartmentId: departments[0]!.id,
        triageCategoryId: categories[0]!.id,
      },
    });
  }
  if (!settings) return;
  const prior = await tx.inboundMailAddress.findUnique({ where: { address } });
  if (prior) return; // Preserve existing operator/admin mappings; SMTP also checks the alias's tenant.
  await tx.inboundMailAddress.create({
    data: {
      tenantId,
      address,
      departmentId: settings.triageDepartmentId,
      categoryId: settings.triageCategoryId,
      isGeneral:
        (await tx.inboundMailAddress.count({
          where: { tenantId, isGeneral: true, active: true },
        })) === 0,
    },
  });
  await tx.configAudit.create({
    data: {
      tenantId,
      actorId,
      entityId: tenantId,
      action: "inbound.platform_address_provisioned",
      detail: { address, source: "platform provisioning" },
    },
  });
}

export async function consumeForwardingProbe(tx: Tx, tenantId: string, code: string | undefined) {
  if (!code) return false;
  const now = new Date();
  const result = await tx.inboundMailSettings.updateMany({
    where: {
      tenantId,
      forwardingProbeHash: createHash("sha256").update(code.toLowerCase()).digest("hex"),
      forwardingProbeStartedAt: { gte: new Date(now.getTime() - 30 * 60000) },
    },
    data: { forwardingProbeHash: null, forwardingVerifiedAt: now },
  });
  return result.count === 1;
}
