import { execFileSync } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(fileURLToPath(new URL("..", import.meta.url)));
const backupRoot = join(workspace, ".local-backups");
const remote = process.env.RESTIC_REMOTE_REPOSITORY ?? "";
const days = Number(process.env.BACKUP_RETENTION_DAYS);
if (
  !/^s3:https?:\/\/[^/]+\/.+\/astrama\/backups$/.test(remote) ||
  !Number.isInteger(days) ||
  days < 7 ||
  days > 3650
) {
  console.error(
    "Configure RESTIC_REMOTE_REPOSITORY with a dedicated S3-compatible /astrama/backups prefix and explicit BACKUP_RETENTION_DAYS (7-3650).",
  );
  process.exit(2);
}
function run(args, silent = false) {
  execFileSync(process.execPath, args, {
    cwd: workspace,
    stdio: silent ? "ignore" : "inherit",
    windowsHide: true,
  });
}
try {
  run([
    "scripts/backup-stack.mjs",
    "backup",
    "--verify",
    "--compose",
    "compose.production.yaml",
    "--project",
    "astrama-production",
    "--env-file",
    ".env.production",
  ]);
  const root = await realpath(backupRoot),
    verified = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^backup-[0-9TZ-]+-[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = join(root, entry.name),
      info = await lstat(directory);
    if (info.isSymbolicLink() || !(await realpath(directory)).startsWith(root + sep))
      throw new Error("Unsafe backup path");
    try {
      const marker = JSON.parse(await readFile(join(directory, "verified.json"), "utf8"));
      if (
        marker.format !== "astrama-restic-v2" ||
        !entry.name.endsWith("-" + marker.backupId) ||
        !Number.isFinite(Date.parse(marker.verifiedAt))
      )
        throw new Error("Invalid completion marker");
      verified.push({ directory, at: Date.parse(marker.verifiedAt) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  if (!verified.length) throw new Error("No restore-verified Restic backup found");
  const latest = verified.toSorted((a, b) => b.at - a.at)[0];
  run(["scripts/backup-stack.mjs", "copy-offsite", "--verify", "--backup", latest.directory]);
} catch {
  console.error(
    "Restic backup, restore verification or offsite copy/check failed; attempting the configured operator alert.",
  );
  try {
    run(
      [
        "scripts/production-watch.mjs",
        process.env.APP_DOMAIN ?? "",
        ".env.production",
        "--backup-failed",
      ],
      true,
    );
  } catch {
    console.error("Operator alert attempt failed. Check private scheduler and monitoring logs.");
  }
  process.exitCode = 1;
}
