import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { hash, argon2id } from "argon2";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { assertDatabaseOwner } from "./recovery.js";

export async function createOperator(db: PrismaClient, body: unknown) {
  const input = z
    .object({
      name: z.string().trim().min(1).max(120),
      email: z.string().trim().email().max(254),
      password: z.string().min(12).max(128),
      role: z.enum(["owner", "support"]),
    })
    .strict()
    .parse(body);
  await assertDatabaseOwner(db);
  const id = randomUUID();
  const passwordHash = await hash(input.password, { type: argon2id });
  await db.$executeRaw`INSERT INTO operators(id,name,email,password_hash,role)
    VALUES(${id}::uuid,${input.name},${input.email.toLowerCase()},${passwordHash},${input.role})`;
  return { id, email: input.email.toLowerCase(), role: input.role, mfaEnrolmentRequired: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, path, extra] = process.argv.slice(2);
  let db: PrismaClient | undefined;
  try {
    if (action !== "create" || !path || extra || !process.env.MIGRATION_DATABASE_URL)
      throw new Error("Usage: node dist/operator-cli.js create private-operator.json");
    const bytes = await readFile(resolve(path));
    if (bytes.length > 10000) throw new Error("Input too large");
    db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
    console.info(JSON.stringify(await createOperator(db, JSON.parse(bytes.toString("utf8")))));
  } catch {
    console.error(
      "Operator creation failed. Check the private input, unique email and owner connection.",
    );
    process.exitCode = 1;
  } finally {
    await db?.$disconnect();
  }
}
