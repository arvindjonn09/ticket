import { Prisma, PrismaClient } from "@prisma/client";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { retentionClasses } from "@astrama/contracts";
import { lockConfiguration, type Tx } from "./database.js";
import { readDataPolicy } from "./data-lifecycle.js";

const requestSchema = z
  .object({
    tenantId: z.string().uuid(),
    operator: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(5).max(1000),
    evidence: z.string().trim().min(3).max(300),
    expectedSlug: z.string().min(1).max(100),
    execute: z.boolean().default(false),
    offline: z.boolean().default(false),
  })
  .strict();
export type OperatorRequest = z.input<typeof requestSchema>;
// Explicit customer business allowlist; security/session/invitation tables never enter an export.
const exportTables = [
  "departments",
  "memberships",
  "categories",
  "subcategories",
  "counters",
  "catalog_items",
  "tickets",
  "activities",
  "approvals",
  "approval_delegations",
  "audits",
  "config_audits",
  "attachments",
  "tenant_data_policies",
  "automation_settings",
  "automation_actions",
] as const;
const ticketTables = [
  "automation_actions",
  "notification_deliveries",
  "idempotency",
  "attachments",
  "approvals",
  "audits",
  "activities",
  "outbox",
] as const;
const tenantTables = [
  "automation_actions",
  "automation_settings",
  "invitation_mails",
  "notification_deliveries",
  "attachments",
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
  "subcategories",
  "categories",
  "counters",
  "departments",
  "users",
  "tenant_data_policies",
] as const;
export function operatorStorage() {
  if (!process.env.S3_ENDPOINT || !process.env.S3_BUCKET)
    throw new Error("Private storage configuration required");
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION ?? "us-east-1",
    forcePathStyle: true,
    ...(process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? {
          credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY,
            secretAccessKey: process.env.S3_SECRET_KEY,
          },
        }
      : {}),
  });
}
async function owner(db: PrismaClient) {
  const [role] = await db.$queryRaw<
    { allowed: boolean }[]
  >`SELECT pg_has_role(current_user,tableowner,'USAGE') AS allowed FROM pg_tables WHERE schemaname='public' AND tablename='tenants'`;
  if (!role?.allowed) throw new Error("Trusted migration-owner connection required");
}
async function scoped<T>(db: PrismaClient, tenantId: string, work: (tx: Tx) => Promise<T>) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      // Read committed after this lock observes holds committed while waiting; S3 deletion cannot be rolled back.
      await lockConfiguration(tx, tenantId);
      return work(tx);
    },
    {
      maxWait: 30000,
      timeout: 300000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}
async function tenant(tx: Tx, input: z.output<typeof requestSchema>) {
  const found = await tx.tenant.findFirst({ where: { id: input.tenantId } });
  if (!found || found.slug !== input.expectedSlug)
    throw new Error("Tenant or expected slug mismatch");
  return found;
}
async function audit(
  db: PrismaClient | Tx,
  input: z.output<typeof requestSchema>,
  operation: "export" | "delete" | "retention",
  outcome: string,
  count = 0,
) {
  await db.$executeRaw`INSERT INTO data_operation_audits(id,tenant_id,tenant_slug,operation,operator_name,reason,evidence,outcome,record_count) VALUES(${randomUUID()}::uuid,${input.tenantId}::uuid,${input.expectedSlug},${operation},${input.operator},${input.reason},${input.evidence},${outcome},${count})`;
}
async function privateDirectory(path: string) {
  await mkdir(path, { mode: 0o700 }); // Exclusive creation also refuses existing paths/symlinks.
  if (process.platform === "win32") {
    const identity = execFileSync("whoami", [], { encoding: "utf8", windowsHide: true }).trim();
    execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else await chmod(path, 0o700);
}
/** Trusted explicit support export, never an ordinary administrator content permission. */
export async function exportTenant(
  db: PrismaClient,
  body: OperatorRequest,
  output: string,
  storage = operatorStorage(),
) {
  const input = requestSchema.parse(body);
  await owner(db);
  await scoped(db, input.tenantId, (tx) => tenant(tx, input));
  const path = resolve(output);
  await privateDirectory(path);
  await audit(db, input, "export", "requested");
  try {
    const manifest = await scoped(db, input.tenantId, async (tx) => {
      const organisation = await tenant(tx, input),
        records: Record<string, unknown> = { organisation };
      // Deliberate field allowlist, including no hashes, MFA state, login counters or invitation material.
      records.users = await tx.user.findMany({
        where: { tenantId: input.tenantId },
        select: {
          id: true,
          tenantId: true,
          name: true,
          email: true,
          role: true,
          active: true,
          revision: true,
          approverEligible: true,
          isVp: true,
          managerId: true,
          homeDepartment: true,
          phone: true,
          jobTitle: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      for (const table of exportTables)
        records[table] = await tx.$queryRawUnsafe(
          `SELECT * FROM "${table}" WHERE tenant_id=$1::uuid`,
          input.tenantId,
        );
      const attachments = await tx.attachment.findMany({
        where: { tenantId: input.tenantId },
        orderBy: { id: "asc" },
      });
      await mkdir(resolve(path, "attachments"), { mode: 0o700 });
      const files: { path: string; sha256: string; bytes: number; attachmentId?: string }[] = [];
      for (const item of attachments) {
        if (!item.storageKey.startsWith(`${input.tenantId}/${item.ticketId}/`))
          throw new Error("Invalid tenant attachment key");
        const object = await storage.send(
          new GetObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: item.storageKey }),
        );
        if (!object.Body) throw new Error("Attachment object missing");
        const bytes = Buffer.from(await object.Body.transformToByteArray());
        if (bytes.length !== item.size) throw new Error("Attachment size mismatch");
        const relative = `attachments/${item.id}`;
        await writeFile(resolve(path, relative), bytes, { flag: "wx", mode: 0o600 });
        files.push({
          path: relative,
          attachmentId: item.id,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        });
      }
      const json = JSON.stringify(records, null, 2);
      await writeFile(resolve(path, "records.json"), json, { flag: "wx", mode: 0o600 });
      files.push({
        path: "records.json",
        sha256: createHash("sha256").update(json).digest("hex"),
        bytes: Buffer.byteLength(json),
      });
      return {
        format: 1,
        tenantId: input.tenantId,
        tenantSlug: input.expectedSlug,
        exportedAt: new Date().toISOString(),
        includesInternalContent: true,
        files,
      };
    });
    await writeFile(resolve(path, "manifest.json"), JSON.stringify(manifest, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    await audit(db, input, "export", "completed", manifest.files.length);
    return { output: path, files: manifest.files.length };
  } catch (error) {
    await audit(db, input, "export", "failed");
    throw error;
  }
}
async function prefixKeys(storage: S3Client, tenantId: string) {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await storage.send(
      new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET!,
        Prefix: `${tenantId}/`,
        ContinuationToken: cursor,
      }),
    );
    for (const object of page.Contents ?? []) if (object.Key) keys.push(object.Key);
    cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !cursor) throw new Error("Storage pagination did not advance");
  } while (cursor);
  return keys;
}
async function deleteKeys(storage: S3Client, tenantId: string, keys: string[]) {
  for (const key of new Set(keys)) {
    if (!key.startsWith(`${tenantId}/`)) throw new Error("Refusing foreign storage key");
    await storage.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }));
  }
}
/** Default preview makes no persistent changes. Retry --execute with identical tenant/slug after partial storage failure. */
export async function deleteTenant(
  db: PrismaClient,
  body: OperatorRequest,
  storage = operatorStorage(),
) {
  const input = requestSchema.parse(body);
  await owner(db);
  const preview = await scoped(db, input.tenantId, async (tx) => {
    await tenant(tx, input);
    const policy = await readDataPolicy(tx, input.tenantId);
    if (policy.legalHold || retentionClasses.some((kind) => policy.retention[kind].legalHold))
      throw new Error("Legal hold blocks tenant deletion");
    return {
      tenantId: input.tenantId,
      tickets: await tx.ticket.count({ where: { tenantId: input.tenantId } }),
      attachments: await tx.attachment.count({ where: { tenantId: input.tenantId } }),
      execute: input.execute,
    };
  });
  if (!input.execute) return preview;
  if (!input.offline)
    throw new Error("Stop API ingress and workers, then assert --offline for tenant deletion");
  await scoped(db, input.tenantId, async (tx) => {
    await tenant(tx, input);
    const policy = await readDataPolicy(tx, input.tenantId);
    if (policy.legalHold || retentionClasses.some((kind) => policy.retention[kind].legalHold))
      throw new Error("Legal hold blocks tenant deletion");
    const keys = (
      await tx.attachment.findMany({
        where: { tenantId: input.tenantId },
        select: { storageKey: true },
      })
    ).map((row) => row.storageKey);
    await tx.tenant.update({ where: { id: input.tenantId }, data: { active: false } });
    await tx.session.deleteMany({ where: { tenantId: input.tenantId } });
    await tx.$executeRaw`INSERT INTO tenant_deletion_jobs(tenant_id,tenant_slug,object_keys) VALUES(${input.tenantId}::uuid,${input.expectedSlug},${JSON.stringify(keys)}::jsonb) ON CONFLICT(tenant_id) DO NOTHING`;
    await audit(tx, input, "delete", "requested", preview.tickets);
  });
  try {
    const [job] = await db.$queryRaw<
      { object_keys: string[] }[]
    >`SELECT object_keys FROM tenant_deletion_jobs WHERE tenant_id=${input.tenantId}::uuid`;
    if (!job) throw new Error("Deletion retry manifest missing");
    await deleteKeys(storage, input.tenantId, [
      ...job.object_keys,
      ...(await prefixKeys(storage, input.tenantId)),
    ]);
    await scoped(db, input.tenantId, async (tx) => {
      await tenant(tx, input);
      const policy = await readDataPolicy(tx, input.tenantId);
      if (policy.legalHold || retentionClasses.some((kind) => policy.retention[kind].legalHold))
        throw new Error("Legal hold blocks tenant deletion");
      await tx.ticket.updateMany({
        where: { tenantId: input.tenantId },
        data: { duplicateOfId: null },
      });
      await tx.department.updateMany({
        where: { tenantId: input.tenantId },
        data: { queueOwnerId: null, substituteId: null },
      });
      await tx.user.updateMany({ where: { tenantId: input.tenantId }, data: { managerId: null } });
      for (const table of tenantTables)
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE tenant_id=$1::uuid`,
          input.tenantId,
        );
      await tx.tenant.delete({ where: { id: input.tenantId } });
      await tx.$executeRaw`DELETE FROM tenant_deletion_jobs WHERE tenant_id=${input.tenantId}::uuid`;
      await audit(tx, input, "delete", "completed", preview.tickets);
    });
    return { ...preview, deleted: true };
  } catch (error) {
    await audit(db, input, "delete", "failed_retry_required", preview.tickets);
    throw error;
  }
}
/** Whole-ticket aggregate retention preserves all configured class periods and holds. No scheduler auto-executes it. */
export async function retainTenant(
  db: PrismaClient,
  body: OperatorRequest,
  storage = operatorStorage(),
) {
  const input = requestSchema.parse(body);
  await owner(db);
  if (input.execute) await audit(db, input, "retention", "requested");
  try {
    return await scoped(db, input.tenantId, async (tx) => {
      const organisation = await tenant(tx, input);
      if (!organisation.active) throw new Error("Tenant unavailable");
      const policy = await readDataPolicy(tx, input.tenantId),
        rules = retentionClasses.map((kind) => policy.retention[kind]);
      if (policy.legalHold || rules.some((rule) => rule.legalHold))
        throw new Error("Legal hold blocks retention");
      if (rules.some((rule) => rule.days === null)) {
        if (input.execute) await audit(tx, input, "retention", "disabled", 0);
        return { execute: input.execute, enabled: false, ticketIds: [] };
      }
      const cutoff = new Date(Date.now() - Math.max(...rules.map((rule) => rule.days!)) * 86400000);
      // Any retained duplicate pointing here protects its target. UpdatedAt includes ticket actions and uploads.
      const rows = await tx.ticket.findMany({
        where: {
          tenantId: input.tenantId,
          state: { in: ["Complete", "Cancelled", "Rejected"] },
          updatedAt: { lt: cutoff },
          attachments: {
            none: {
              createdAt: {
                gte: new Date(Date.now() - policy.retention.attachments.days! * 86400000),
              },
            },
          },
          audits: {
            none: {
              createdAt: { gte: new Date(Date.now() - policy.retention.audits.days! * 86400000) },
            },
          },
          duplicates: { none: {} },
        },
        select: { id: true },
      });
      const ids = rows.map((row) => row.id);
      if (!input.execute || !ids.length) {
        if (input.execute) await audit(tx, input, "retention", "completed", 0);
        return {
          execute: input.execute,
          enabled: true,
          cutoff: cutoff.toISOString(),
          ticketIds: ids,
        };
      }
      const attachments = await tx.attachment.findMany({
        where: { tenantId: input.tenantId, ticketId: { in: ids } },
      });
      await deleteKeys(
        storage,
        input.tenantId,
        attachments.map((row) => row.storageKey),
      );
      await tx.notificationDelivery.deleteMany({
        where: { tenantId: input.tenantId, event: { ticketId: { in: ids } } },
      });
      for (const table of ticketTables.filter((name) => name !== "notification_deliveries"))
        await tx.$executeRawUnsafe(
          `DELETE FROM "${table}" WHERE tenant_id=$1::uuid AND ticket_id=ANY($2::uuid[])`,
          input.tenantId,
          ids,
        );
      await tx.ticket.deleteMany({ where: { tenantId: input.tenantId, id: { in: ids } } });
      await audit(tx, input, "retention", "completed", ids.length);
      return { execute: true, enabled: true, cutoff: cutoff.toISOString(), ticketIds: ids };
    });
  } catch (error) {
    if (input.execute) await audit(db, input, "retention", "failed_retry_required");
    throw error;
  }
}
async function main(args: string[]) {
  const operation = args.shift(),
    flags = new Map<string, string | boolean>();
  const accepted = [
    "--tenant",
    "--expected-slug",
    "--operator",
    "--reason",
    "--evidence",
    "--output",
    "--execute",
    "--offline",
  ];
  while (args.length) {
    const key = args.shift()!;
    if (!accepted.includes(key) || flags.has(key)) throw new Error("Invalid or duplicate option");
    if (key === "--execute" || key === "--offline") flags.set(key, true);
    else {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error("Missing option value");
      flags.set(key, value);
    }
  }
  const input = requestSchema.parse({
    tenantId: flags.get("--tenant"),
    expectedSlug: flags.get("--expected-slug"),
    operator: flags.get("--operator"),
    reason: flags.get("--reason"),
    evidence: flags.get("--evidence"),
    execute: flags.get("--execute") ?? false,
    offline: flags.get("--offline") ?? false,
  });
  if (!process.env.MIGRATION_DATABASE_URL)
    throw new Error("Explicit migration-owner connection required");
  const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
  try {
    if (operation === "export") {
      if (typeof flags.get("--output") !== "string")
        throw new Error("New private output path required");
      console.info(JSON.stringify(await exportTenant(db, input, flags.get("--output") as string)));
    } else if (operation === "delete") console.info(JSON.stringify(await deleteTenant(db, input)));
    else if (operation === "retention") console.info(JSON.stringify(await retainTenant(db, input)));
    else throw new Error("Choose export, delete or retention");
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2)).catch(() => {
    console.error(
      "Data operation failed. Check tenant/slug, legal holds, explicit support authorization, owner connection and private storage. Review the owner-only audit and retry manifest; no content or credentials are logged.",
    );
    process.exitCode = 1;
  });
}
