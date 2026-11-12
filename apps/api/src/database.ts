import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
export type Tx = Prisma.TransactionClient;
export async function lockConfiguration(tx: Tx, tenantId: string) {
  // ponytail: serializes tenant configuration/ticket operations; use shared or finer locks if measured load requires it.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`configuration:${tenantId}`}, 0))`;
}
@Injectable()
export class Database extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ log: [] });
  }
  async assertRuntimeRole() {
    const [role] = await this.$queryRaw<
      { unsafe: boolean }[]
    >`SELECT EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND (r.rolsuper OR r.rolbypassrls OR r.rolreplication OR r.rolcreatedb OR r.rolcreaterole OR r.rolname='astrama_auth_reader' OR EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner=r.rolname))) AS unsafe`;
    if (!role || role.unsafe)
      throw new Error("API requires a non-owner PostgreSQL role without RLS bypass");
  }
  withTenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        const active = await tx.tenant.findFirst({ where: { id: tenantId, active: true } });
        if (!active) throw new Error("Tenant unavailable");
        return work(tx);
      },
      { maxWait: 10000, timeout: 15000 },
    );
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
