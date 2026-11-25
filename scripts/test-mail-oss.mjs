import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = `astrama-mail-oss-check-${randomUUID().slice(0, 8)}`;
const ownerPassword = randomBytes(24).toString("hex");
const runtimePassword = randomBytes(24).toString("hex");
const encryptionKey = randomBytes(32).toString("hex");
const domain = process.env.MAIL_OSS_DOMAIN || "astrama.localhost";
const ownerUrl = `postgresql://astrama_owner:${ownerPassword}@db:5432/astrama`;
const runtimeUrl = `postgresql://astrama_app:${runtimePassword}@db:5432/astrama`;
const secrets = [ownerPassword, runtimePassword, encryptionKey, ownerUrl, runtimeUrl];
const containers = [],
  volumes = [];
let networkCreated = false;

function docker(args, input) {
  try {
    return execFileSync("docker", args, {
      cwd: root,
      input,
      encoding: input ? undefined : "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    })
      ?.toString()
      .trim();
  } catch (error) {
    let detail = error.stderr?.toString() || error.stdout?.toString() || "";
    for (const secret of secrets) detail = detail.replaceAll(secret, "[redacted]");
    throw new Error(`Docker ${args[0]} failed: ${detail.slice(-4000)}`);
  }
}

function start(name, args) {
  const container = `${prefix}-${name}`;
  containers.push(container);
  docker(["run", "-d", "--name", container, "--network", prefix, "--network-alias", name, ...args]);
  return container;
}
const env = (values) => Object.entries(values).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
const common = {
  NODE_ENV: "development",
  PLATFORM_MODE: "hosted",
  APP_BASE_DOMAIN: domain,
  INBOUND_MAIL_DOMAIN: `in.${domain}`,
  DATABASE_URL: runtimeUrl,
  MFA_ENCRYPTION_KEY: encryptionKey,
  MAIL_OSS_DOMAIN: domain,
  MAIL_OSS_TEST_RUN: prefix,
};

try {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const apiImage =
    process.env.MAIL_OSS_TEST_API_IMAGE || `astrama-mail-oss-check-api:${head.slice(0, 12)}`;
  try {
    docker(["image", "inspect", apiImage]);
  } catch {
    console.info("Building an immutable HEAD API snapshot for the disposable mail check");
    const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    });
    docker(["build", "-f", "infra/Dockerfile", "--target", "api", "-t", apiImage, "-"], archive);
  }
  const initImage = `${prefix}-init`;
  docker(["build", "-f", "infra/mail-oss/Dockerfile", "-t", initImage, "."]);
  for (const name of ["private", "ca"]) {
    volumes.push(`${prefix}-${name}`);
    docker(["volume", "create", `${prefix}-${name}`]);
  }
  docker(["network", "create", "--internal", prefix]);
  networkCreated = true;
  console.info("Initializing private Mox credentials and a separate public CA volume");
  docker([
    "run",
    "--rm",
    "--network",
    "none",
    "-e",
    `MAIL_OSS_DOMAIN=${domain}`,
    "-v",
    `${prefix}-private:/mox`,
    "-v",
    `${prefix}-ca:/mail-oss-ca`,
    initImage,
  ]);
  start("db", [
    "-e",
    "POSTGRES_USER=astrama_owner",
    "-e",
    `POSTGRES_PASSWORD=${ownerPassword}`,
    "-e",
    "POSTGRES_DB=astrama",
    "postgres:16-bookworm",
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      docker(["exec", `${prefix}-db`, "pg_isready", "-U", "astrama_owner", "-d", "astrama"]);
      break;
    } catch {
      if (attempt >= 30) throw new Error("Disposable PostgreSQL was not ready");
      await new Promise((done) => setTimeout(done, 500));
    }
  }
  docker([
    "run",
    "--rm",
    "--network",
    prefix,
    ...env({ ...common, MIGRATION_DATABASE_URL: ownerUrl, APP_DB_PASSWORD: runtimePassword }),
    apiImage,
    "sh",
    "-c",
    "pnpm db:bootstrap && pnpm db:migrate",
  ]);
  const checkArgs = [
    "run",
    "--rm",
    "--network",
    prefix,
    "-v",
    `${resolve(root, "infra/mail-oss/check.mjs")}:/check.mjs:ro`,
    "-v",
    `${prefix}-private:/mox:ro`,
    "-v",
    `${prefix}-ca:/mail-oss-ca:ro`,
    ...env({
      ...common,
      MIGRATION_DATABASE_URL: ownerUrl,
      NODE_EXTRA_CA_CERTS: "/mail-oss-ca/ca.crt",
    }),
    apiImage,
    "node",
    "/check.mjs",
  ];
  console.info(docker([...checkArgs, "seed"]));
  start("mail", [
    "axllent/mailpit@sha256:aef2aacc11f075ec0fb6874275ee4a421e688e11a96ebb296134d1735c7761ce",
  ]);
  const intake = start("mail-intake", [
    ...env({ ...common, MAIL_INTAKE_PORT: "2525" }),
    apiImage,
    "node",
    "apps/api/dist/mail-intake.js",
  ]);
  start("mox", [
    "-v",
    `${prefix}-private:/mox`,
    "r.xmox.nl/mox:v0.0.17@sha256:8889e7b48fdd5b0b07b51dd11a6d06536334ec442652f2ffb1e1df3a9d45074e",
    "mox",
    "-config",
    "/mox/mox.conf",
    "serve",
  ]);
  console.info(docker([...checkArgs, "check"]));
  docker(["restart", intake]);
  console.info(docker([...checkArgs, "durable"]));
  console.info("OSS mail check passed; no host ports or external mail delivery were used");
} finally {
  for (const name of containers.reverse()) {
    try {
      docker(["rm", "-f", "-v", name]);
    } catch {}
  }
  if (networkCreated) {
    try {
      docker(["network", "rm", prefix]);
    } catch {}
  }
  for (const name of volumes) {
    try {
      docker(["volume", "rm", name]);
    } catch {}
  }
  try {
    docker(["image", "rm", `${prefix}-init`]);
  } catch {}
}
