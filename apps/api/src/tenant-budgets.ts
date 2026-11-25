import { HttpException } from "@nestjs/common";
import type { Tx } from "./database.js";

export const tenantLimitVariables = {
  requests: "TENANT_REQUESTS_PER_MINUTE",
  uploads: "TENANT_UPLOAD_BYTES_PER_DAY",
  inbound: "TENANT_INBOUND_PER_HOUR",
  exports: "TENANT_EXPORTS_PER_DAY",
} as const;
export function tenantBudgetConfigError(env: NodeJS.ProcessEnv = process.env) {
  if (env.PLATFORM_MODE !== "hosted") return null;
  for (const key of Object.values(tenantLimitVariables)) {
    if (!env[key] && env.NODE_ENV !== "production") continue;
    if (!/^[1-9]\d*$/.test(env[key] ?? "") || !Number.isSafeInteger(Number(env[key])))
      return `${key} must be an explicit positive safe integer`;
  }
  return null;
}
/** Atomic admission shared by every replica; rejected reservations do not increment usage. */
export async function reserveTenantBudget(
  tx: Tx,
  tenantId: string,
  kind: keyof typeof tenantLimitVariables,
  amount = 1,
  now = new Date(),
) {
  if (process.env.PLATFORM_MODE !== "hosted") return;
  const error = tenantBudgetConfigError();
  if (error) throw new Error(error);
  const text = process.env[tenantLimitVariables[kind]];
  if (!text) return; // Local development only; production refuses absent allowances.
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid budget amount");
  const limit = BigInt(text),
    quantity = BigInt(amount);
  const duration = kind === "requests" ? 60000 : kind === "inbound" ? 3600000 : 86400000;
  const start = new Date(Math.floor(now.getTime() / duration) * duration);
  const accepted = await tx.$queryRaw<{ used: bigint }[]>`
    INSERT INTO tenant_budgets(tenant_id,kind,window_start,used)
    SELECT ${tenantId}::uuid,${kind},${start},${quantity}::bigint WHERE ${quantity}::bigint<=${limit}::bigint
    ON CONFLICT(tenant_id,kind,window_start) DO UPDATE SET used=tenant_budgets.used+EXCLUDED.used
      WHERE tenant_budgets.used<=${limit}::bigint-EXCLUDED.used RETURNING used`;
  if (!accepted.length)
    throw new HttpException(
      {
        message: `Organisation ${kind} allowance reached. Try again after the current window.`,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((start.getTime() + duration - now.getTime()) / 1000),
        ),
      },
      429,
    );
}
