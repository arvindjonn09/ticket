import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Buffer } from "node:buffer";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

// Official BSD-2 release0.19.1, checked19November2026. No Docker socket in this container.
export const resticImage =
  "restic/restic@sha256:136600b6ff6843d61d355f7f71f460a166429f35de6fd11b568fece3c9a4d510";
export const resticFormat = "astrama-restic-v2";
const artifacts = new Set([
  "database.dump",
  "storage.tar",
  "secrets.json",
  "manifest.json",
  "verification.json",
]);
export function validBackupIdentity(id, artifact) {
  if (!/^[a-f0-9]{32}$/.test(id) || (artifact !== undefined && !artifacts.has(artifact)))
    throw new Error("Invalid Restic backup identity");
}
export function parseSnapshot(output, id, artifact) {
  validBackupIdentity(id, artifact);
  const rows = JSON.parse(output);
  const selected = rows.filter(
    (row) =>
      /^[a-f0-9]{64}$/.test(row.id) &&
      row.hostname === "astrama" &&
      row.tags?.includes("astrama") &&
      row.tags.includes(`backup:${id}`) &&
      row.tags.includes(`artifact:${artifact}`) &&
      row.paths?.length === 1 &&
      row.paths[0] === `/${artifact}`,
  );
  if (selected.length !== 1)
    throw new Error("Expected exactly one authenticated Restic artifact snapshot");
  return selected[0].id;
}

export async function resticStore(docker, key, root, { child, run, secure, initialize = false }) {
  const repository = resolve(root, "restic-repository");
  if (repository.includes(","))
    throw new Error("Restic repository mount path cannot contain commas");
  await mkdir(repository, { recursive: true, mode: 0o700 });
  if ((await lstat(repository)).isSymbolicLink())
    throw new Error("Restic repository cannot be a link");
  await secure(repository, true);
  const environment = { RESTIC_PASSWORD: key.toString("hex"), RESTIC_REPOSITORY: "/repository" };
  const base = [
    ...docker,
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--user",
    process.platform === "win32" ? "1000:1000" : `${process.getuid()}:${process.getgid()}`,
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=128m",
    "--mount",
    `type=bind,source=${repository},target=/repository`,
    ...Object.keys(environment).flatMap((name) => ["-e", name]),
    resticImage,
    "--no-cache",
  ];
  const execute = (args, input) => run([...base, ...args], { env: environment, input });
  try {
    await lstat(resolve(repository, "config"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (!initialize)
      throw new Error("Initialize the Restic repository with --init-repository before capture");
    await execute(["init"]);
  }
  // Fail with a wrong key before quiescing any source service.
  await execute(["snapshots", "--json"]);
  const installationId = JSON.parse(await execute(["cat", "config"])).id;
  if (!/^[a-f0-9]{64}$/.test(installationId)) throw new Error("Invalid Restic repository identity");
  const find = async (id, artifact) =>
    parseSnapshot(
      await execute(["snapshots", "--json", "--tag", `astrama,backup:${id},artifact:${artifact}`]),
      id,
      artifact,
    );
  const put = async (id, artifact, source) => {
    validBackupIdentity(id, artifact);
    const task = child(
      [
        ...base,
        "backup",
        "--stdin",
        "--stdin-filename",
        artifact,
        "--host",
        "astrama",
        "--tag",
        "astrama",
        "--tag",
        `installation:${installationId}`,
        "--tag",
        `backup:${id}`,
        "--tag",
        `artifact:${artifact}`,
        "--json",
      ],
      { env: environment },
    );
    task.process.stdout.resume();
    try {
      await Promise.all([pipeline(source, task.process.stdin), task.done]);
    } catch (error) {
      task.process.kill();
      throw error;
    }
    await find(id, artifact);
  };
  const dump = async (id, artifact, target) => {
    const snapshot = await find(id, artifact);
    const task = child([...base, "dump", snapshot, `/${artifact}`], { env: environment });
    task.process.stdin.end();
    try {
      await Promise.all([pipeline(task.process.stdout, target), task.done]);
    } catch (error) {
      task.process.kill();
      throw error;
    }
  };
  const getJson = async (id, artifact) => {
    const chunks = [];
    let size = 0;
    await dump(
      id,
      artifact,
      new Writable({
        write(chunk, _encoding, done) {
          size += chunk.length;
          if (size > 16 * 1024 * 1024)
            return done(new Error("Restic metadata exceeds supported limit"));
          chunks.push(chunk);
          done();
        },
      }),
    );
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  return {
    repository,
    put,
    dump,
    getJson,
    putJson: (id, artifact, value) => put(id, artifact, Readable.from([JSON.stringify(value)])),
    check: () => execute(["check", "--read-data"]),
    async copyRemote(id, remote, retentionDays) {
      validBackupIdentity(id);
      if (
        typeof remote !== "string" ||
        !remote ||
        /[\r\n]/.test(remote) ||
        !/^s3:https?:\/\/[^/]+\/.+\/astrama\/backups$/.test(remote)
      )
        throw new Error(
          "RESTIC_REMOTE_REPOSITORY must select an explicit S3-compatible /astrama/backups prefix",
        );
      if (!Number.isInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650)
        throw new Error("Explicit backup retention must be7–3650days");
      // Backend credentials enter only through environment, never argv or diagnostic output.
      const remoteEnv = {
        ...environment,
        RESTIC_REPOSITORY: remote,
        RESTIC_FROM_REPOSITORY: "/repository",
        RESTIC_FROM_PASSWORD: environment.RESTIC_PASSWORD,
      };
      for (const name of [
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_DEFAULT_REGION",
      ])
        if (process.env[name]) remoteEnv[name] = process.env[name];
      // Only the copy/check container gets egress. The repository must already exist.
      const args = [...base];
      args.splice(args.indexOf("none"), 1, "bridge");
      const imageIndex = args.indexOf(resticImage);
      args.splice(
        imageIndex,
        0,
        ...Object.keys(remoteEnv)
          .filter((name) => !(name in environment))
          .flatMap((name) => ["-e", name]),
      );
      const remoteRun = (command) => run([...args, ...command], { env: remoteEnv });
      await remoteRun(["copy", "--tag", `astrama,backup:${id}`]);
      await remoteRun(["check", "--read-data"]);
      // Native policy, explicit operator duration; keep latest per artifact path even when older.
      await remoteRun([
        "forget",
        "--tag",
        `astrama,installation:${installationId}`,
        "--group-by",
        "host,paths",
        "--keep-within",
        `${retentionDays}d`,
        "--prune",
      ]);
    },
  };
}

export async function resticPointer(directory) {
  const path = resolve(directory, "restic.json"),
    info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error("Restic pointer must be a bounded regular file");
  const pointer = JSON.parse(await readFile(path, "utf8"));
  if (pointer.format !== resticFormat) throw new Error("Unsupported Restic pointer format");
  validBackupIdentity(pointer.backupId);
  if (!directory.endsWith(`-${pointer.backupId}`))
    throw new Error("Backup directory and Restic identity differ");
  return pointer;
}
