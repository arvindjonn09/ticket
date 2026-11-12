import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Run before migrations; runtime business grants are versioned in migration 010. */
export async function bootstrapDatabase() {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL,
    password = process.env.APP_DB_PASSWORD;
  if (
    !ownerUrl ||
    !password ||
    password.length < 12 ||
    password.length > 256 ||
    password.includes("\0")
  )
    throw new Error(
      "Explicit owner connection and a 12–256 character runtime password are required",
    );
  const db = new PrismaClient({ datasourceUrl: ownerUrl, log: [] });
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('astrama:runtime-bootstrap', 0))`;
      const [existing] = await tx.$queryRaw<
        { unsafe: boolean }[]
      >`SELECT r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid) OR EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner=r.rolname) AS unsafe FROM pg_roles r WHERE r.rolname='astrama_app'`;
      if (existing?.unsafe)
        throw new Error("Refusing an existing privileged or public-table-owning runtime role");
      if (!existing)
        await tx.$executeRawUnsafe(
          "CREATE ROLE astrama_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS",
        );
      // PostgreSQL utility statements cannot bind parameters. E literals escape both quotes and backslashes.
      const literal = password.replaceAll("\\", "\\\\").replaceAll("'", "''");
      await tx.$executeRawUnsafe(
        `ALTER ROLE astrama_app LOGIN PASSWORD E'${literal}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`,
      );
      await tx.$executeRawUnsafe("GRANT USAGE ON SCHEMA public TO astrama_app");
      const [schema] = await tx.$queryRaw<
        { owner: string }[]
      >`SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname='pgboss'`;
      if (schema && schema.owner !== "astrama_app")
        throw new Error("Refusing to take ownership of an existing queue schema");
      await tx.$executeRawUnsafe("CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION astrama_app");
    });
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bootstrapDatabase()
    .then(() =>
      console.info("Restricted runtime role and queue schema prepared. Apply migrations next."),
    )
    .catch(() => {
      console.error(
        "Database bootstrap failed. Check the explicit owner connection, runtime password and existing role/schema privileges. No credentials are printed.",
      );
      process.exitCode = 1;
    });
}
