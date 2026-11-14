import { randomBytes } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";

const domain = process.argv[2] ?? "";
if (!/^[A-Za-z0-9.-]+$/.test(domain)) {
  console.error("Usage: node scripts/create-production-secrets.mjs app.example.com");
  process.exit(2);
}

const target = ".env.production";
const values = {
  APP_DOMAIN: domain,
  POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
  APP_DB_PASSWORD: randomBytes(24).toString("hex"),
  MFA_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  S3_ACCESS_KEY: randomBytes(16).toString("hex"),
  S3_SECRET_KEY: randomBytes(32).toString("hex"),
};
const template = await readFile(".env.production.example", "utf8");
const content = template.replace(/^([A-Z0-9_]+)=.*$/gm, (line, key) =>
  key in values ? `${key}=${values[key]}` : line,
);
await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
await chmod(target, 0o600);
console.log(
  "Created .env.production with mode 600. Fill SMTP, alert email, TLS_DIRECTORY, and RELEASE_TAG locally.",
);
