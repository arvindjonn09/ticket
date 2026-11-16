import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { OTP } from "otplib";

const otp = new OTP();
export function totp(secret: string, step: number, digits = 6): string {
  return otp.generateSync({ secret, epoch: step * 30, digits });
}
export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const result = otp.verifySync({
    secret,
    token: code,
    epoch: now / 1000,
    epochTolerance: 30,
    ...(lastStep >= 0 ? { afterTimeStep: lastStep } : {}),
  });
  return result.valid ? Math.floor(now / 30000) + result.delta : null;
}
export function encryptionKey(value = process.env.MFA_ENCRYPTION_KEY): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(value ?? ""))
    throw new Error("Encryption key must be 64 hexadecimal characters");
  return Buffer.from(value!, "hex");
}
export function encryptSecret(secret: string, identity: string, key = encryptionKey()): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(identity));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decryptSecret(encrypted: string, identity: string, key = encryptionKey()): string {
  const data = Buffer.from(encrypted, "base64"),
    decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(identity));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}
