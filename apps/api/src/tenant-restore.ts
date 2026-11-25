import { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { z } from "zod";
import {
  assertDataOwner,
  dataOperationAudit,
  exportTables,
  operatorStorage,
} from "./operator-data.js";
import { lockConfigurationExclusive, type Tx } from "./database.js";

const requestSchema = z
  .object({
    tenantId: z.string().uuid(),
    expectedSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    operator: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(5).max(1000),
    evidence: z.string().trim().min(3).max(300),
    deleteAfter: z.coerce
      .date()
      .refine((date) => date > new Date(), "Choose a future quarantine deletion deadline"),
    execute: z.boolean().default(false),
    offline: z.literal(true),
  })
  .strict();
const manifestSchema = z
  .object({
    format: z.literal(1),
    tenantId: z.string().uuid(),
    tenantSlug: z.string(),
    exportedAt: z.string().datetime(),
    includesInternalContent: z.literal(true),
    files: z.array(
      z
        .object({
          path: z.string(),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z
            .number()
            .int()
            .nonnegative()
            .max(256 * 1024 * 1024),
          attachmentId: z.string().uuid().optional(),
        })
        .strict(),
    ),
  })
  .strict();
type Row = Record<string, unknown>;
class RestorePreview extends Error {}
async function checkedFile(root: string, path: string, maximum: number) {
  if (
    path !== "manifest.json" &&
    path !== "records.json" &&
    !/^attachments\/[0-9a-f-]{36}$/.test(path)
  )
    throw new Error("Unexpected export path");
  const full = join(root, path),
    info = await lstat(full);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maximum ||
    (await realpath(full)) !== full
  )
    throw new Error("Export files must be bounded regular files without symlinks");
  return readFile(full);
}
async function insertRows(tx: Tx, table: (typeof exportTables)[number], rows: Row[]) {
  const columns = await tx.$queryRaw<{ name: string }[]>`
    SELECT attname AS name FROM pg_attribute WHERE attrelid=${`public.${table}`}::regclass
      AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum`;
  const allowed = new Set(columns.map((c) => c.name));
  for (const row of rows) {
    if (Object.keys(row).some((key) => !allowed.has(key)))
      throw new Error("Unexpected record field");
    const names = Object.keys(row);
    if (!names.length) throw new Error("Empty record");
    const quoted = names.map((name) => `"${name.replaceAll('"', '""')}"`).join(",");
    await tx.$executeRawUnsafe(
      `INSERT INTO "${table}" (${quoted}) SELECT ${quoted} FROM jsonb_populate_record(NULL::"${table}",$1::jsonb)`,
      JSON.stringify(row),
    );
  }
}

/** Trusted offline restore into an absent identity; credentials and external integrations are never restored. */
export async function restoreTenant(
  db: PrismaClient,
  body: unknown,
  directory: string,
  storage = operatorStorage(),
) {
  const input = requestSchema.parse(body);
  await assertDataOwner(db);
  if (!isAbsolute(directory)) throw new Error("Use an absolute private export directory");
  const root = await realpath(directory);
  const manifest = manifestSchema.parse(
    JSON.parse((await checkedFile(root, "manifest.json", 1024 * 1024)).toString("utf8")),
  );
  if (manifest.tenantId !== input.tenantId || manifest.tenantSlug !== input.expectedSlug)
    throw new Error("Export identity does not match the requested tenant");
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (seen.has(file.path)) throw new Error("Duplicate export path");
    seen.add(file.path);
    if (file.path !== "records.json" && file.path !== `attachments/${file.attachmentId}`)
      throw new Error("Attachment identity mismatch");
    const bytes = await checkedFile(root, file.path, 256 * 1024 * 1024);
    if (
      bytes.length !== file.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    )
      throw new Error("Export checksum mismatch");
  }
  if (!seen.has("records.json")) throw new Error("Business records missing");
  // ponytail: bounded in-memory export; stream records when customer exports exceed 256 MiB.
  const records = JSON.parse(
    (await checkedFile(root, "records.json", 256 * 1024 * 1024)).toString("utf8"),
  ) as Record<string, unknown>;
  const organisation = z
    .object({
      id: z.string().uuid(),
      slug: z.string(),
      name: z.string(),
      brandName: z.string(),
      timezone: z.string(),
      locale: z.string(),
      seatLimit: z.number().int().positive(),
      incidentPrefix: z.string(),
      requestPrefix: z.string(),
      primaryColour: z.string(),
      defaultPriority: z.string(),
      defaultSeverity: z.string(),
    })
    .parse(records.organisation);
  if (organisation.id !== input.tenantId || organisation.slug !== input.expectedSlug)
    throw new Error("Record identity mismatch");
  if (Object.keys(records).some((key) => !["organisation", "users", ...exportTables].includes(key)))
    throw new Error("Unexpected export table");
  const users = z
    .array(
      z
        .object({
          id: z.string().uuid(),
          tenantId: z.string().uuid(),
          name: z.string(),
          email: z.string().email(),
          role: z.enum(["employee", "agent", "admin", "system"]),
          revision: z.number().int().nonnegative(),
          approverEligible: z.boolean(),
          isVp: z.boolean(),
          managerId: z.string().uuid().nullable(),
          homeDepartment: z.string(),
          phone: z.string(),
          jobTitle: z.string(),
          createdAt: z.coerce.date(),
          updatedAt: z.coerce.date(),
          active: z.boolean(),
        })
        .strict(),
    )
    .parse(records.users);
  const tables = new Map<(typeof exportTables)[number], Row[]>();
  for (const table of exportTables) {
    // Format-1 exports from before SA-06 did not include optional SLA configuration.
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .parse(records[table] ?? (table === "sla_settings" ? [] : undefined));
    if (rows.some((row) => row.tenant_id !== input.tenantId))
      throw new Error("Foreign tenant record");
    tables.set(table, rows);
  }
  if (users.some((user) => user.tenantId !== input.tenantId))
    throw new Error("Foreign tenant user");
  const attachments = tables.get("attachments")!;
  for (const row of attachments) {
    const id = z.string().uuid().parse(row.id),
      ticket = z.string().uuid().parse(row.ticket_id);
    if (
      !seen.has(`attachments/${id}`) ||
      typeof row.storage_key !== "string" ||
      !row.storage_key.startsWith(`${input.tenantId}/${ticket}/`) ||
      row.storage_key.slice(`${input.tenantId}/${ticket}/`.length).includes("/")
    )
      throw new Error("Invalid attachment storage identity");
    if (manifest.files.find((f) => f.attachmentId === id)?.bytes !== row.size)
      throw new Error("Attachment size mismatch");
  }
  if (manifest.files.length !== attachments.length + 1) throw new Error("Unreferenced export file");
  await dataOperationAudit(db, input, "restore", "requested");
  try {
    await db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${input.tenantId},true)`;
        await lockConfigurationExclusive(tx, input.tenantId);
        if (
          await tx.tenant.findFirst({
            where: { OR: [{ id: input.tenantId }, { slug: input.expectedSlug }] },
          })
        )
          throw new Error("Restore target already exists");
        const existing = await storage.send(
          new ListObjectsV2Command({
            Bucket: process.env.S3_BUCKET!,
            Prefix: `${input.tenantId}/`,
            MaxKeys: 1,
          }),
        );
        if (existing.Contents?.length) throw new Error("Restore storage prefix must be empty");
        await tx.tenant.create({
          data: {
            ...organisation,
            active: false,
            status: "read_only",
            readOnlyReason: "operator",
            readOnlySince: new Date(),
            deleteAfter: input.deleteAfter,
            trialEndsAt: null,
            planId: null,
            stripeCustomerId: null,
            stripeSubscriptionId: null,
          },
        });
        for (const user of users)
          await tx.user.create({
            data: { ...user, managerId: null, active: false, passwordHash: "!" },
          });
        for (const user of users)
          if (user.managerId)
            await tx.user.update({ where: { id: user.id }, data: { managerId: user.managerId } });
        for (const [table, rows] of tables)
          await insertRows(
            tx,
            table,
            table === "tickets" ? rows.map((row) => ({ ...row, duplicate_of_id: null })) : rows,
          );
        for (const row of tables.get("tickets")!)
          if (row.duplicate_of_id)
            await tx.$executeRaw`UPDATE tickets SET duplicate_of_id=${String(row.duplicate_of_id)}::uuid WHERE id=${String(row.id)}::uuid AND tenant_id=${input.tenantId}::uuid`;
        if (!input.execute) throw new RestorePreview();
        const uploaded: string[] = [];
        try {
          for (const row of attachments) {
            const key = String(row.storage_key),
              bytes = await checkedFile(root, `attachments/${row.id}`, 256 * 1024 * 1024);
            uploaded.push(key); // A failed response can still have written the object.
            await storage.send(
              new PutObjectCommand({
                Bucket: process.env.S3_BUCKET!,
                Key: key,
                Body: bytes,
                ContentType: "application/octet-stream",
              }),
            );
          }
        } catch (error) {
          // Compensate before releasing the new tenant's database identity lock.
          for (const key of uploaded)
            await storage.send(
              new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET!, Key: key }),
            );
          throw error;
        }
        await dataOperationAudit(
          tx,
          input,
          "restore",
          "completed",
          users.length + tables.get("tickets")!.length,
        );
      },
      { maxWait: 30000, timeout: 300000 },
    );
  } catch (error) {
    if (error instanceof RestorePreview) {
      await dataOperationAudit(db, input, "restore", "preview");
      return {
        execute: false,
        tenantId: input.tenantId,
        users: users.length,
        tickets: tables.get("tickets")!.length,
      };
    }
    await dataOperationAudit(db, input, "restore", "failed");
    throw error;
  }
  return { execute: true, tenantId: input.tenantId, quarantined: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [request, directory, extra] = process.argv.slice(2);
  let db: PrismaClient | undefined;
  try {
    if (!request || !directory || extra || !process.env.MIGRATION_DATABASE_URL)
      throw new Error("Private request and export directory required");
    const bytes = await readFile(request);
    if (bytes.length > 10000) throw new Error("Input too large");
    db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL });
    console.info(
      JSON.stringify(await restoreTenant(db, JSON.parse(bytes.toString("utf8")), directory)),
    );
  } catch {
    console.error(
      "Restore failed. Check the private request, export integrity, absent target and offline owner access.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
