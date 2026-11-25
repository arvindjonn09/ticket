import type { Database } from "./database.js";

const reservedSlugs = new Set([
  "www",
  "app",
  "api",
  "admin",
  "ops",
  "mail",
  "smtp",
  "imap",
  "status",
  "support",
  "help",
  "billing",
  "docs",
  "static",
  "assets",
  "cdn",
  "auth",
  "login",
  "signup",
  "staging",
  "dev",
  "test",
]);

export type HostTarget =
  | { kind: "single" }
  | { kind: "tenant"; slug: string }
  | { kind: "public" }
  | { kind: "operator" }
  | { kind: "unknown" };

function validSlug(value: string) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

export function validTenantSlug(value: string, env: NodeJS.ProcessEnv = process.env) {
  const configuredReserved = new Set(
    (env.RESERVED_SLUGS ?? "")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  const base = env.APP_BASE_DOMAIN?.toLowerCase().replace(/\.$/, "");
  if (base)
    for (const origin of [env.PUBLIC_SITE_ORIGIN, env.OPERATOR_ORIGIN]) {
      const host = originHost(origin),
        suffix = `.${base}`;
      if (host?.endsWith(suffix)) configuredReserved.add(host.slice(0, -suffix.length));
    }
  return validSlug(value) && !reservedSlugs.has(value) && !configuredReserved.has(value);
}

function hostname(value: string | string[] | undefined) {
  if (typeof value !== "string" || !value || value.includes(",")) return null;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

function originHost(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? parsed.hostname.toLowerCase().replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

export function platformMode(env: NodeJS.ProcessEnv = process.env) {
  return env.PLATFORM_MODE === "hosted" ? "hosted" : "single";
}

export function platformConfigError(env: NodeJS.ProcessEnv = process.env) {
  if (env.PLATFORM_MODE && !["single", "hosted"].includes(env.PLATFORM_MODE))
    return "PLATFORM_MODE must be single or hosted";
  if (platformMode(env) === "single") {
    const origin = env.APP_ORIGIN;
    return origin && originHost(origin) ? null : "APP_ORIGIN must be an exact origin";
  }
  const base = env.APP_BASE_DOMAIN?.toLowerCase().replace(/\.$/, "");
  if (
    !base ||
    base.length > 253 ||
    !base.includes(".") ||
    base.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  )
    return "APP_BASE_DOMAIN must be a hostname";
  if (!originHost(env.PUBLIC_SITE_ORIGIN) || !originHost(env.OPERATOR_ORIGIN))
    return "PUBLIC_SITE_ORIGIN and OPERATOR_ORIGIN must be exact origins";
  if (originHost(env.PUBLIC_SITE_ORIGIN) === originHost(env.OPERATOR_ORIGIN))
    return "Public site and operator origins must use different hostnames";
  if (
    ![env.PUBLIC_SITE_ORIGIN, env.OPERATOR_ORIGIN].every((value) => {
      try {
        return new URL(value!).protocol === "https:" || env.NODE_ENV !== "production";
      } catch {
        return false;
      }
    })
  )
    return "Hosted production origins must use HTTPS";
  return null;
}

export function classifyHost(
  hostHeader: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HostTarget {
  if (platformMode(env) === "single") return { kind: "single" };
  const host = hostname(hostHeader);
  const base = env.APP_BASE_DOMAIN?.toLowerCase().replace(/\.$/, "");
  if (!host || !base) return { kind: "unknown" };
  if (host === originHost(env.PUBLIC_SITE_ORIGIN)) return { kind: "public" };
  if (host === originHost(env.OPERATOR_ORIGIN)) return { kind: "operator" };
  const suffix = `.${base}`;
  if (!host.endsWith(suffix)) return { kind: "unknown" };
  const slug = host.slice(0, -suffix.length);
  if (!validTenantSlug(slug, env)) return { kind: "unknown" };
  return { kind: "tenant", slug };
}

export function tenantOrigin(slug: string, env: NodeJS.ProcessEnv = process.env) {
  if (platformMode(env) === "single") return env.APP_ORIGIN!;
  if (!validTenantSlug(slug, env)) throw new Error("Invalid tenant hostname");
  const base = env.APP_BASE_DOMAIN?.toLowerCase().replace(/\.$/, "");
  if (!base) throw new Error("APP_BASE_DOMAIN must be configured");
  const port = env.PUBLIC_SITE_ORIGIN ? new URL(env.PUBLIC_SITE_ORIGIN).port : "";
  return `https://${slug}.${base}${port ? `:${port}` : ""}`;
}

export function expectedRequestOrigin(
  hostHeader: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (platformMode(env) === "single") return env.APP_ORIGIN;
  const target = classifyHost(hostHeader, env);
  return target.kind === "tenant" ? tenantOrigin(target.slug, env) : null;
}

export async function resolveHost(
  db: Database,
  hostHeader: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
) {
  const target = classifyHost(hostHeader, env);
  if (target.kind !== "tenant") return target;
  const [row] = await db.$queryRaw<{ tenant_id: string }[]>`
    SELECT * FROM resolve_active_tenant_host(${target.slug})
  `;
  return row
    ? { kind: "tenant" as const, slug: target.slug, tenantId: row.tenant_id }
    : { kind: "unknown" as const };
}

const tlsChecks = new Map<string, { start: number; count: number }>();
export async function tlsDomainAllowed(
  db: Database,
  domain: string,
  sourceIp: string,
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
) {
  const current = tlsChecks.get(sourceIp);
  if (!current || now - current.start >= 60_000) tlsChecks.set(sourceIp, { start: now, count: 1 });
  else if (++current.count > 120) return false;
  if (tlsChecks.size > 1000)
    for (const [ip, entry] of tlsChecks) if (now - entry.start >= 60_000) tlsChecks.delete(ip);
  const target = classifyHost(domain, env);
  if (target.kind === "public" || target.kind === "operator") return true;
  if (target.kind === "single") return hostname(domain) === originHost(env.APP_ORIGIN);
  if (target.kind !== "tenant") return false;
  const [row] = await db.$queryRaw<{ allowed: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM resolve_active_tenant_host(${target.slug})) AS allowed
  `;
  return row?.allowed === true;
}
