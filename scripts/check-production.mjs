import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateProduction(env, allowLocal = false) {
  const required = [
    "APP_DOMAIN",
    "RELEASE_TAG",
    "POSTGRES_PASSWORD",
    "APP_DB_PASSWORD",
    "MFA_ENCRYPTION_KEY",
    "S3_ACCESS_KEY",
    "S3_SECRET_KEY",
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
    "OPERATOR_ALERT_EMAIL",
  ];
  const issues = required.filter((key) => !env[key]?.trim()).map((key) => `${key} is required`);
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(env.APP_DOMAIN ?? "") ||
    (!allowLocal && !env.APP_DOMAIN?.includes("."))
  )
    issues.push("APP_DOMAIN must be a lowercase hostname");
  if (!/^v\d+\.\d+\.\d+-[a-f0-9]{12}$/.test(env.RELEASE_TAG ?? ""))
    issues.push("RELEASE_TAG must match a published version-SHA release tag");
  for (const key of ["POSTGRES_PASSWORD", "APP_DB_PASSWORD"])
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(env[key] ?? "") || /demo|local|change.?me/i.test(env[key]))
      issues.push(`${key} must be a strong URL-safe value`);
  if (env.POSTGRES_PASSWORD === env.APP_DB_PASSWORD)
    issues.push("Database owner and runtime passwords must differ");
  if (
    !/^[a-f0-9]{64}$/i.test(env.MFA_ENCRYPTION_KEY ?? "") ||
    new Set(env.MFA_ENCRYPTION_KEY).size < 8
  )
    issues.push("MFA_ENCRYPTION_KEY must be a random 32-byte hex key");
  if (
    (env.S3_SECRET_KEY?.length ?? 0) < 20 ||
    /astrama-local|change.?me/i.test(env.S3_SECRET_KEY ?? "")
  )
    issues.push("S3_SECRET_KEY must be independently generated");
  if (
    !["465", "587"].includes(env.SMTP_PORT ?? "587") ||
    !["true", "false"].includes(env.SMTP_SECURE ?? "false")
  )
    issues.push("Configure an authenticated TLS SMTP port and SMTP_SECURE");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.OPERATOR_ALERT_EMAIL ?? ""))
    issues.push("OPERATOR_ALERT_EMAIL must be an email address");
  if (
    ((env.SMTP_PORT ?? "587") === "465" && (env.SMTP_SECURE ?? "false") !== "true") ||
    ((env.SMTP_PORT ?? "587") === "587" && (env.SMTP_SECURE ?? "false") !== "false")
  )
    issues.push("Use SMTP_SECURE=true for port 465, or false with STARTTLS on port 587");
  return issues;
}

async function main() {
  const file = resolve(process.argv[2] ?? ".env.production"),
    allowLocal = process.argv.includes("--allow-local");
  const env = { ...process.env };
  for (const raw of (await readFile(file, "utf8")).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error("Use KEY=value lines in the deployment environment file");
    let value = match[2].trim();
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    )
      value = value.slice(1, -1);
    // Keep env-file values literal. Complex Compose expansion is intentionally rejected.
    if (value.includes("${")) throw new Error("Resolve environment substitutions before preflight");
    env[match[1]] = value;
  }
  const issues = validateProduction(env, allowLocal);
  if (issues.length) throw new Error(issues.join("\n"));
  if (process.platform !== "win32" && (await stat(file)).mode & 0o077)
    throw new Error("Environment file must be accessible only by its owner");
  console.info("Production preflight passed. Values and private keys were not printed.");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Preflight failed");
    process.exitCode = 1;
  });
