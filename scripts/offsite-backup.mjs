import { execFileSync } from "node:child_process";
import { lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = join(workspace, ".local-backups");
const remote = process.env.BACKUP_OFFSITE_REMOTE ?? "";
const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS);
if (
  !/(^|\/)astrama\/backups$/.test(remote) ||
  !Number.isInteger(retentionDays) ||
  retentionDays < 7 ||
  retentionDays > 3650
) {
  console.error(
    "Configure BACKUP_OFFSITE_REMOTE ending in /astrama/backups and BACKUP_RETENTION_DAYS (7–3650).",
  );
  process.exit(2);
}

function run(program, args, silent = false) {
  execFileSync(program, args, { cwd: workspace, stdio: silent ? "ignore" : "inherit" });
}

function safeSnapshot(name) {
  return /^backup-[0-9TZ-]+-[0-9a-f-]{36}$/.test(name);
}

async function snapshots() {
  const root = await realpath(backupRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const verified = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !safeSnapshot(entry.name)) continue;
    const path = join(root, entry.name);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const real = await realpath(path);
    if (!real.startsWith(`${root}${sep}`)) continue;
    try {
      await stat(join(real, "verification.json.enc"));
      verified.push({ name: entry.name, path: real, mtime: info.mtimeMs });
    } catch {
      // Incomplete encrypted captures are retained for operator investigation.
    }
  }
  return { root, verified };
}

try {
  run(process.execPath, [
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
  const { root, verified } = await snapshots();
  if (!verified.length) throw new Error("No completed verified backup found");
  const latest = verified.toSorted((a, b) => b.mtime - a.mtime)[0];
  const destination = `${remote}/${latest.name}`;
  run(
    "rclone",
    ["copy", latest.path, destination, "--immutable", "--checksum", "--transfers", "2"],
    true,
  );
  run("rclone", ["check", latest.path, destination, "--one-way"], true);

  const cutoff = Date.now() - retentionDays * 86400000;
  for (const snapshot of verified) {
    if (snapshot.mtime >= cutoff || snapshot.name === latest.name) continue;
    const parent = await realpath(dirname(snapshot.path));
    if (parent !== root || !safeSnapshot(snapshot.name))
      throw new Error("Backup retention path validation failed");
    await rm(snapshot.path, { recursive: true, force: false });
  }
  run("rclone", ["delete", remote, "--min-age", `${retentionDays}d`], true);
  console.info("Verified encrypted backup copied offsite; retention applied.");
} catch {
  console.error(
    "Encrypted backup or offsite verification failed; attempting the configured operator alert.",
  );
  try {
    run(
      process.execPath,
      [
        "scripts/production-watch.mjs",
        process.env.APP_DOMAIN ?? "",
        ".env.production",
        "--backup-failed",
      ],
      true,
    );
  } catch {
    console.error(
      "Operator alert attempt failed. Check the private service scheduler and monitoring logs.",
    );
  }
  process.exitCode = 1;
}
