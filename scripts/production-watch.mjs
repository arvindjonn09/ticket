import { execFileSync } from "node:child_process";
import { statfsSync } from "node:fs";
import { connect } from "node:tls";

const backupFailed = process.argv.includes("--backup-failed");
const args = process.argv.filter((value) => value !== "--backup-failed").slice(2);
const [domain = process.env.APP_DOMAIN ?? "", envFile = ".env.production"] = args;
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain)) {
  console.error(
    "Usage: node scripts/production-watch.mjs app.example.com [.env.production] [--backup-failed]",
  );
  process.exit(2);
}

const filesystem = statfsSync("/");
const diskPercent =
  Math.round(((filesystem.blocks - filesystem.bavail) / filesystem.blocks) * 1000) / 10;
const daysUntilCertificateExpiry = await new Promise((resolve) => {
  const socket = connect({ host: domain, port: 443, servername: domain, timeout: 7000 }, () => {
    const validTo = socket.getPeerCertificate().valid_to;
    socket.end();
    resolve(validTo ? Math.floor((Date.parse(validTo) - Date.now()) / 86400000) : 0);
  });
  socket.once("error", () => resolve(0));
  socket.setTimeout(7000, () => {
    socket.destroy();
    resolve(0);
  });
});

const compose = [
  "compose",
  "--env-file",
  envFile,
  "-f",
  "compose.production.yaml",
  "--profile",
  "operations",
  "run",
  "--rm",
  "--no-deps",
  "-e",
  `HOST_DISK_USAGE_PERCENT=${diskPercent}`,
  "-e",
  `TLS_CERTIFICATE_DAYS_REMAINING=${daysUntilCertificateExpiry}`,
  ...(backupFailed ? ["-e", "FORCE_BACKUP_FAILURE=1"] : []),
  "monitor",
];
execFileSync("docker", compose, { stdio: "inherit" });
