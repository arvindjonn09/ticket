// Read compatibility for the retained v1 format. New captures use native Restic.
// encryptStream exists only for the legacy authentication regression fixture.
import { createCipheriv, createDecipheriv } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("ASTRAMA-BACKUP-1\n");
const format = "astrama-stack-backup-v1";

export async function encryptStream(source, path, key, identity) {
  const { randomBytes } = await import("node:crypto");
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${format}:${identity}`));
  await writeFile(path, Buffer.concat([magic, iv]), { flag: "wx", mode: 0o600 });
  await pipeline(source, cipher, createWriteStream(path, { flags: "a", mode: 0o600 }));
  await appendFile(path, cipher.getAuthTag());
}

export async function decryptStream(path, target, key, identity) {
  const handle = await open(path, "r");
  let size, header, tag;
  try {
    size = (await handle.stat()).size;
    if (size < magic.length + 12 + 16) throw new Error("Truncated encrypted artifact");
    header = Buffer.alloc(magic.length + 12);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, magic.length).equals(magic))
      throw new Error("Unknown encrypted artifact format");
    tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(magic.length));
  decipher.setAAD(Buffer.from(`${format}:${identity}`));
  decipher.setAuthTag(tag);
  await pipeline(
    createReadStream(path, { start: header.length, end: size - 17 }),
    decipher,
    target,
  );
}
