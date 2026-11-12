import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  decryptStream,
  encryptStream,
  privateKeyFile,
  safeBackupPath,
  secure,
  validKey,
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
