import { PrismaClient } from "@prisma/client";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { assertDatabaseOwner } from "./recovery.js";
import { decryptSecret, encryptSecret, encryptionKey } from "./mfa.js";

/** Stop API, workers and provisioning first. Validate every ciphertext and replace in one transaction. */
export async function rotateEncryptionKey(
  db: PrismaClient,
  oldKeyHex: string,
  newKeyHex: string,
  apply = false,
) {
  const oldKey = encryptionKey(oldKeyHex),
    newKey = encryptionKey(newKeyHex);
  if (timingSafeEqual(oldKey, newKey)) throw new Error("New encryption key must differ");
  await assertDatabaseOwner(db);
  return db.$transaction(
    async (tx) => {
      // Fail closed for an owner constrained by FORCE RLS instead of reporting a partial/empty rotation.
      await tx.$executeRaw`SET LOCAL row_security=off`;
      await tx.$executeRaw`LOCK TABLE public.users,public.operators,public.invitation_mails,public.password_recoveries,public.password_recovery_requests,public.public_mail_outbox,public.inbound_mail_settings,public.platform_mail_profiles,public.tenant_outgoing_mail,public.mail_oauth_connections IN ACCESS EXCLUSIVE MODE`;
      const secrets = await tx.$queryRaw<
        { id: string; tenant_id: string; secret: string }[]
      >`SELECT id,tenant_id,mfa_secret AS secret FROM users WHERE mfa_secret IS NOT NULL`;
      const invitations = await tx.$queryRaw<
        { id: string; tenant_id: string; user_id: string; secret: string }[]
      >`SELECT id,tenant_id,user_id,encrypted_url AS secret FROM invitation_mails WHERE encrypted_url IS NOT NULL`;
      const recoveries = await tx.$queryRaw<
        { id: string; tenant_id: string; user_id: string; secret: string }[]
      >`SELECT id,tenant_id,user_id,encrypted_url AS secret FROM password_recoveries WHERE encrypted_url IS NOT NULL`;
      const requests = await tx.$queryRaw<
        { id: string; secret: string }[]
      >`SELECT id,encrypted_request AS secret FROM password_recovery_requests WHERE encrypted_request IS NOT NULL`;
      const operators = await tx.$queryRaw<{ id: string; secret: string }[]>`
        SELECT id,encrypted_mfa_secret AS secret FROM operators WHERE encrypted_mfa_secret IS NOT NULL`;
      const publicMails = await tx.$queryRaw<{ id: string; identity: string; secret: string }[]>`
        SELECT id,identity,encrypted_url AS secret FROM public_mail_outbox WHERE encrypted_url IS NOT NULL`;
      const inbound = await tx.$queryRaw<{ tenant_id: string; secret: string }[]>`
        SELECT tenant_id,encrypted_webhook_secret AS secret FROM inbound_mail_settings WHERE encrypted_webhook_secret IS NOT NULL`;
      const platformProfiles = await tx.$queryRaw<{ id: string; secret: string }[]>`
        SELECT id,encrypted_password AS secret FROM platform_mail_profiles`;
      const tenantSmtp = await tx.$queryRaw<
        { tenant_id: string; secret: string }[]
      >`SELECT tenant_id,encrypted_secret AS secret FROM tenant_outgoing_mail WHERE encrypted_secret IS NOT NULL`;
      const oauth = await tx.$queryRaw<
        {
          id: string;
          tenant_id: string;
          encrypted_pkce: string | null;
          encrypted_cache: string | null;
        }[]
      >`SELECT id,tenant_id,encrypted_pkce,encrypted_cache FROM mail_oauth_connections WHERE encrypted_pkce IS NOT NULL OR encrypted_cache IS NOT NULL`;
      const reencrypt = (secret: string, identity: string) => {
        const plain = decryptSecret(secret, identity, oldKey),
          encrypted = encryptSecret(plain, identity, newKey);
        if (decryptSecret(encrypted, identity, newKey) !== plain)
          throw new Error("New encryption key verification failed");
        return encrypted;
      };
      for (const row of secrets) {
        const encrypted = reencrypt(row.secret, `${row.tenant_id}:${row.id}`);
        if (apply)
          await tx.$executeRaw`UPDATE users SET mfa_secret=${encrypted} WHERE id=${row.id}::uuid AND tenant_id=${row.tenant_id}::uuid`;
      }
      for (const row of invitations) {
        const encrypted = reencrypt(row.secret, `invitation:${row.tenant_id}:${row.user_id}`);
        if (apply)
          await tx.$executeRaw`UPDATE invitation_mails SET encrypted_url=${encrypted} WHERE id=${row.id}::uuid AND tenant_id=${row.tenant_id}::uuid`;
      }
      for (const row of recoveries) {
        const encrypted = reencrypt(
          row.secret,
          `recovery:${row.tenant_id}:${row.user_id}:${row.id}`,
        );
        if (apply)
          await tx.$executeRaw`UPDATE password_recoveries SET encrypted_url=${encrypted} WHERE id=${row.id}::uuid AND tenant_id=${row.tenant_id}::uuid`;
      }
      for (const row of requests) {
        const encrypted = reencrypt(row.secret, `recovery-request:${row.id}`);
        if (apply)
          await tx.$executeRaw`UPDATE password_recovery_requests SET encrypted_request=${encrypted} WHERE id=${row.id}::uuid`;
      }
      for (const row of operators) {
        const encrypted = reencrypt(row.secret, `operator:${row.id}`);
        if (apply)
          await tx.$executeRaw`UPDATE operators SET encrypted_mfa_secret=${encrypted} WHERE id=${row.id}::uuid`;
      }
      for (const row of publicMails) {
        const encrypted = reencrypt(row.secret, row.identity);
        if (apply)
          await tx.$executeRaw`UPDATE public_mail_outbox SET encrypted_url=${encrypted} WHERE id=${row.id}::uuid`;
      }
      for (const row of inbound) {
        const encrypted = reencrypt(row.secret, `inbound-mail:${row.tenant_id}`);
        if (apply)
          await tx.$executeRaw`UPDATE inbound_mail_settings SET encrypted_webhook_secret=${encrypted} WHERE tenant_id=${row.tenant_id}::uuid`;
      }
      for (const row of platformProfiles) {
        const encrypted = reencrypt(row.secret, "platform-smtp");
        if (apply)
          await tx.$executeRaw`UPDATE platform_mail_profiles SET encrypted_password=${encrypted} WHERE id=${row.id}::uuid`;
      }
      for (const row of tenantSmtp) {
        const encrypted = reencrypt(row.secret, `smtp:${row.tenant_id}`);
        if (apply)
          await tx.$executeRaw`UPDATE tenant_outgoing_mail SET encrypted_secret=${encrypted} WHERE tenant_id=${row.tenant_id}::uuid`;
      }
      for (const row of oauth) {
        const pkce = row.encrypted_pkce
          ? reencrypt(row.encrypted_pkce, `smtp-oauth-state:${row.tenant_id}:${row.id}`)
          : null;
        const cache = row.encrypted_cache
          ? reencrypt(row.encrypted_cache, `smtp:${row.tenant_id}`)
          : null;
        if (apply)
          await tx.$executeRaw`UPDATE mail_oauth_connections SET encrypted_pkce=${pkce},encrypted_cache=${cache} WHERE tenant_id=${row.tenant_id}::uuid AND id=${row.id}::uuid`;
      }
      return {
        applied: apply,
        mfaSecrets: secrets.length,
        invitationLinks: invitations.length,
        recoveryLinks: recoveries.length,
        recoveryRequests: requests.length,
        operatorMfaSecrets: operators.length,
        publicMailLinks: publicMails.length,
        inboundWebhookSecrets: inbound.length,
        platformSmtpProfiles: platformProfiles.length,
        tenantSmtpSecrets: tenantSmtp.length,
        mailOAuthConnections: oauth.length,
      };
    },
    { maxWait: 10000, timeout: 120000 },
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (
      !args.includes("--offline") ||
      args.some((arg) => !["--offline", "--apply"].includes(arg)) ||
      !process.env.MIGRATION_DATABASE_URL
    )
      throw new Error("Usage: node dist/key-rotation.js --offline [--apply]");
    const db = new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
    try {
      console.info(
        JSON.stringify(
          await rotateEncryptionKey(
            db,
            process.env.MFA_ENCRYPTION_KEY ?? "",
            process.env.MFA_NEW_ENCRYPTION_KEY ?? "",
            args.includes("--apply"),
          ),
        ),
      );
    } finally {
      await db.$disconnect();
    }
  } catch {
    console.error(
      "Key rotation failed; the transaction was rolled back. Check maintenance mode, owner connection, old/new keys and encrypted data. Keys are never printed.",
    );
    process.exitCode = 1;
  }
}
