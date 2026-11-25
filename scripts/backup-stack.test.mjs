import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { spawn } from "node:child_process";
import { resticStore, parseSnapshot, validBackupIdentity } from "./backup-restic.mjs";
import {
  decryptStream,
  encryptStream,
  privateKeyFile,
  safeBackupPath,
  secure,
  validKey,
  restoreTarCommand,
} from "./backup-stack.mjs";

test("backup authentication, wrong keys, byte tampering and workspace/junction boundaries", async () => {
  const directory = await safeBackupPath(resolve(".local-backups", `check-${randomUUID()}`));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assert.doesNotReject(() => secure(directory, true), "initial private directory ACL");
  const artifacts = [],
    link = resolve(directory, "outside-link");
  let linked = false;
  const file = (name) => {
    const path = resolve(directory, name);
    artifacts.push(path);
    return path;
  };
  const plaintext = Buffer.concat([Buffer.from("synthetic backup check\0"), randomBytes(8192)]),
    key = randomBytes(32);
  const collect = async (path, encryptionKey, identity) => {
    const chunks = [];
    await decryptStream(
      path,
      new Writable({
        write(chunk, _encoding, done) {
          chunks.push(chunk);
          done();
        },
      }),
      encryptionKey,
      identity,
    );
    return Buffer.concat(chunks);
  };
  try {
    assert.throws(() => validKey("short"));
    assert.equal(validKey("ac".repeat(32)).length, 32);
    const path = file("synthetic.enc");
    await encryptStream(Readable.from([plaintext]), path, key, "database");
    await assert.doesNotReject(() => secure(path), "private file ACL");
    await privateKeyFile(path);
    if (process.platform === "win32") {
      assert.equal(
        spawnSync("icacls", [directory, "/grant", "*S-1-1-0:(OI)(CI)F"], { windowsHide: true })
          .status,
        0,
      );
      await assert.rejects(privateKeyFile(path));
      await assert.doesNotReject(
        () => secure(directory, true),
        "remove explicit Everyone directory grant",
      );
      await privateKeyFile(path);
    }
    assert.deepEqual(await collect(path, key, "database"), plaintext);
    await assert.rejects(collect(path, randomBytes(32), "database"));
    await assert.rejects(collect(path, key, "storage"));
    const bytes = await readFile(path);
    bytes[40] ^= 0xff;
    const tampered = file("tampered.enc");
    await writeFile(tampered, bytes);
    await assert.rejects(collect(tampered, key, "database"));
    const truncated = file("truncated.enc");
    await writeFile(truncated, bytes.subarray(0, 7));
    await assert.rejects(collect(truncated, key, "database"));
    await assert.rejects(safeBackupPath(resolve(".local-backups", "..", "outside")));
    await assert.rejects(safeBackupPath(resolve(".local-backups-other")));
    await symlink(resolve("."), link, process.platform === "win32" ? "junction" : "dir");
    linked = true;
    await assert.rejects(safeBackupPath(resolve(link, "generated.enc")));
  } finally {
    if (linked) await unlink(link);
    for (const path of artifacts) await unlink(await safeBackupPath(path));
    await rmdir(await safeBackupPath(directory));
  }
});

test("Restic artifact identity rejects ambiguous and cross-artifact selections", () => {
  const id = "a".repeat(32),
    snapshot = {
      id: "b".repeat(64),
      hostname: "astrama",
      tags: ["astrama", `backup:${id}`, "artifact:database.dump"],
      paths: ["/database.dump"],
    };
  assert.equal(parseSnapshot(JSON.stringify([snapshot]), id, "database.dump"), snapshot.id);
  assert.throws(() => parseSnapshot(JSON.stringify([snapshot, snapshot]), id, "database.dump"));
  assert.throws(() => parseSnapshot(JSON.stringify([snapshot]), id, "storage.tar"));
  assert.throws(() => validBackupIdentity("../outside", "database.dump"));
  assert.throws(() => validBackupIdentity(id, "../secrets.json"));
});

test(
  "restore tar consumes complete padded records and still rejects malformed archives",
  { skip: process.env.RUN_RESTIC_TESTS !== "true", timeout: 60000 },
  async () => {
    const archive = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "postgres:16-bookworm",
        "sh",
        "-c",
        "printf sentinel >/tmp/backup-padding-fixture; exec tar --blocking-factor=4096 -C /tmp -cf - backup-padding-fixture",
      ],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.equal(archive.status, 0, "create the synthetic GNU tar archive");
    assert.equal(
      archive.stdout.length,
      4096 * 512,
      "archive includes large trailing record padding",
    );
    const consume = async (bytes) => {
      const child = spawn(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "postgres:16-bookworm",
          "sh",
          "-c",
          "mkdir /data && " + restoreTarCommand.join(" ") + " && cat /data/backup-padding-fixture",
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
      );
      const chunks = [];
      child.stdout.on("data", (chunk) => chunks.push(chunk));
      const done = new Promise((accept, reject) => {
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0 ? accept() : reject(new Error("Archive extraction failed")),
        );
      });
      done.catch(() => {});
      let sent = 0;
      const source = Readable.from(
        (async function* () {
          for (let start = 0; start < bytes.length; start += 16384) {
            const chunk = bytes.subarray(start, start + 16384);
            sent += chunk.length;
            yield chunk;
            await delay(2);
          }
        })(),
      );
      try {
        await Promise.all([pipeline(source, child.stdin), done]);
      } catch (error) {
        child.kill();
        throw error;
      }
      assert.equal(sent, bytes.length, "all archive bytes reached the consumer");
      return Buffer.concat(chunks).toString("utf8");
    };
    assert.equal(await consume(archive.stdout), "sentinel");
    await assert.rejects(consume(Buffer.from("malformed archive")));
    await assert.rejects(
      consume(archive.stdout.subarray(0, 516)),
      "truncated file content must still fail",
    );
  },
);

test(
  "native Restic container round-trips streams, rejects wrong passwords and detects byte corruption",
  { skip: process.env.RUN_RESTIC_TESTS !== "true", timeout: 120000 },
  async () => {
    const directory = await safeBackupPath(
      resolve(".local-backups", `restic-check-${randomUUID()}`),
    );
    await mkdir(directory, { mode: 0o700 });
    await secure(directory, true);
    const key = randomBytes(32),
      id = randomUUID().replaceAll("-", "");
    const child = (args, { env = {} } = {}) => {
      const task = spawn("docker", args, {
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      const done = new Promise((accept, reject) => {
        task.once("error", reject);
        task.once("close", (code) =>
          code === 0 ? accept() : reject(new Error("Restic command failed")),
        );
      });
      done.catch(() => {});
      return { process: task, done };
    };
    const run = async (args, { input, ...options } = {}) => {
      const task = child(args, options),
        chunks = [];
      task.process.stdout.on("data", (chunk) => chunks.push(chunk));
      task.process.stdin.end(input);
      await task.done;
      return Buffer.concat(chunks).toString("utf8");
    };
    const plaintext = randomBytes(8192);
    try {
      const store = await resticStore([], key, directory, { child, run, secure, initialize: true });
      await store.put(id, "database.dump", Readable.from([plaintext]));
      const chunks = [];
      await store.dump(
        id,
        "database.dump",
        new Writable({
          write(chunk, _encoding, done) {
            chunks.push(chunk);
            done();
          },
        }),
      );
      assert.deepEqual(Buffer.concat(chunks), plaintext);
      await assert.rejects(resticStore([], randomBytes(32), directory, { child, run, secure }));
      await store.check();
      const data = resolve(store.repository, "data");
      let packs = 0;
      for (const prefix of await readdir(data)) {
        const entries = await readdir(resolve(data, prefix));
        for (const entry of entries) {
          const pack = resolve(data, prefix, entry);
          const corrupted = await readFile(pack);
          corrupted[Math.floor(corrupted.length / 2)] ^= 0xff;
          await chmod(pack, 0o600);
          await writeFile(pack, corrupted);
          packs++;
        }
      }
      assert.ok(packs > 0, "Restic wrote encrypted data packs");
      await assert.rejects(store.check());
      await assert.rejects(
        store.dump(
          id,
          "database.dump",
          new Writable({
            write(_chunk, _encoding, done) {
              done();
            },
          }),
        ),
      );
    } finally {
      key.fill(0);
      await rm(await safeBackupPath(directory), { recursive: true, force: true });
    }
  },
);
