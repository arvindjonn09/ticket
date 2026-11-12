import { expect, it } from "vitest";
import { base32, decryptSecret, encryptSecret, totp, verifyTotp } from "../src/mfa.js";

it("matches RFC 4226 and RFC 6238 SHA1 vectors, rejects replay and authenticates ciphertext identity", () => {
  const secret = base32(Buffer.from("12345678901234567890"));
  expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  for (const [step, value] of [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ].entries())
    expect(totp(secret, step)).toBe(value);
  for (const [seconds, value] of [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ] as const)
    expect(totp(secret, Math.floor(seconds / 30), 8)).toBe(value);
  expect(verifyTotp(secret, "287082", -1, 59000)).toBe(1);
  expect(verifyTotp(secret, "287082", 1, 59000)).toBeNull();
  expect(verifyTotp(secret, "755224", -1, 90000)).toBeNull();
  process.env.MFA_ENCRYPTION_KEY ??= "ab".repeat(32);
  const encrypted = encryptSecret(secret, "tenant:user");
  expect(encrypted).not.toContain(secret);
  expect(decryptSecret(encrypted, "tenant:user")).toBe(secret);
  expect(() => decryptSecret(encrypted, "other:user")).toThrow();
});
