import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { validateProduction } from "./check-production.mjs";

test("production preflight rejects missing, shared and demonstration secrets", () => {
  assert.ok(validateProduction({}).length > 5);
  const env = {
    APP_DOMAIN: "desk.example.com",
    RELEASE_TAG: "v0.1.0-1234567890ab",
    POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
    APP_DB_PASSWORD: randomBytes(24).toString("hex"),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    S3_ACCESS_KEY: "independent-access",
    S3_SECRET_KEY: randomBytes(24).toString("hex"),
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "service",
    SMTP_PASSWORD: "private-mail-password",
    SMTP_FROM: "desk@example.com",
    OPERATOR_ALERT_EMAIL: "operations@example.com",
  };
  assert.deepEqual(validateProduction(env), []);
  assert.ok(
    validateProduction({ ...env, PLATFORM_MODE: "hosted" }).some((value) =>
      value.includes("STRIPE_SECRET_KEY is required for hosted mode"),
    ),
  );
  assert.deepEqual(
    validateProduction({
      ...env,
      PLATFORM_MODE: "hosted",
      TENANT_REQUESTS_PER_MINUTE: "2",
      TENANT_UPLOAD_BYTES_PER_DAY: "1024",
      TENANT_INBOUND_PER_HOUR: "2",
      TENANT_OUTBOUND_PER_HOUR: "2",
      TENANT_EXPORTS_PER_DAY: "2",
      APP_BASE_DOMAIN: "change-me.example",
      PUBLIC_SITE_ORIGIN: "https://change-me.example",
      PUBLIC_SITE_HOST: "change-me.example",
      OPERATOR_ORIGIN: "https://ops.change-me.example",
      OPERATOR_SITE_HOST: "ops.change-me.example",
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_synthetic",
      STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
      CAPTCHA_HMAC_SECRET: randomBytes(32).toString("hex"),
    }),
    [],
  );
  assert.ok(
    validateProduction({
      ...env,
      PLATFORM_MODE: "hosted",
      APP_BASE_DOMAIN: "change-me.example",
      PUBLIC_SITE_ORIGIN: "https://change-me.example",
      PUBLIC_SITE_HOST: "site.change-me.example",
      OPERATOR_ORIGIN: "https://ops.change-me.example",
      OPERATOR_SITE_HOST: "ops.change-me.example",
      PAYMENT_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_synthetic",
      STRIPE_WEBHOOK_SECRET: "whsec_synthetic",
      CAPTCHA_HMAC_SECRET: randomBytes(32).toString("hex"),
    }).some((value) => value.includes("PUBLIC_SITE_HOST must match PUBLIC_SITE_ORIGIN")),
  );
  assert.ok(
    validateProduction({ ...env, APP_DOMAIN: "Desk.Example.com" }).some((value) =>
      value.includes("lowercase hostname"),
    ),
  );
  assert.ok(
    validateProduction({ ...env, SMTP_PORT: "465", SMTP_SECURE: "false" }).some((value) =>
      value.includes("Use SMTP_SECURE"),
    ),
  );
  assert.ok(
    validateProduction({ ...env, SMTP_PORT: "587", SMTP_SECURE: "true" }).some((value) =>
      value.includes("Use SMTP_SECURE"),
    ),
  );
  assert.deepEqual(validateProduction({ ...env, SMTP_PORT: "465", SMTP_SECURE: "true" }), []);
  assert.ok(
    validateProduction({ ...env, APP_DB_PASSWORD: env.POSTGRES_PASSWORD }).some((value) =>
      value.includes("must differ"),
    ),
  );
  assert.ok(
    validateProduction({ ...env, MFA_ENCRYPTION_KEY: "ac".repeat(32) }).some((value) =>
      value.includes("random"),
    ),
  );
});

test("production environment parser accepts required S3 variable names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "astrama-preflight-")),
    file = join(directory, "synthetic.env");
  try {
    await writeFile(file, "S3_ACCESS_KEY=synthetic-check");
    const result = spawnSync(process.execPath, [resolve("scripts/check-production.mjs"), file], {
      encoding: "utf8",
      env: {},
      windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /APP_DOMAIN is required/);
    assert.doesNotMatch(result.stderr, /Use KEY=value/);
  } finally {
    await unlink(file);
    await rmdir(directory);
  }
});

test("Microsoft 365 is optional and rejects partial credentials and foreign OAuth callbacks", () => {
  const microsoftIssues = (env) => validateProduction(env).filter((issue) => /M365_/.test(issue));
  assert.deepEqual(microsoftIssues({}), []);
  const env = {
    APP_ORIGIN: "https://desk.example.com",
    M365_CLIENT_ID: randomUUID(),
    M365_CLIENT_SECRET_FILE: "/run/microsoft365/client-secret",
    M365_REDIRECT_URI: "https://desk.example.com/api/mail/microsoft365/callback",
  };
  assert.deepEqual(microsoftIssues(env), []);
  assert.ok(microsoftIssues({ M365_CLIENT_ID: env.M365_CLIENT_ID }).length >= 2);
  assert.equal(microsoftIssues({ ...env, M365_CLIENT_SECRET: "synthetic-secret" }).length, 1);
  for (const callback of [
    "http://desk.example.com/api/mail/microsoft365/callback",
    "https://foreign.example.com/api/mail/microsoft365/callback",
    `${env.M365_REDIRECT_URI}?next=foreign`,
    `${env.M365_REDIRECT_URI}#fragment`,
    "https://desk.example.com/wrong-path",
  ])
    assert.equal(microsoftIssues({ ...env, M365_REDIRECT_URI: callback }).length, 1);
  assert.deepEqual(
    microsoftIssues({ ...env, PLATFORM_MODE: "hosted", PUBLIC_SITE_ORIGIN: env.APP_ORIGIN }),
    [],
  );
});
