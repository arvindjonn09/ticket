import { PrismaClient } from '@prisma/client';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { assertDatabaseOwner } from './recovery.js';
import { decryptSecret, encryptSecret, encryptionKey } from './mfa.js';

/** Stop API, workers and provisioning first. Validate every ciphertext and replace in one transaction. */
export async function rotateEncryptionKey(db: PrismaClient, oldKeyHex: string, newKeyHex: string, apply=false) {
  const oldKey=encryptionKey(oldKeyHex), newKey=encryptionKey(newKeyHex);
  if (timingSafeEqual(oldKey,newKey)) throw new Error('New encryption key must differ');
  await assertDatabaseOwner(db);
  return db.$transaction(async tx => {
    // Fail closed for an owner constrained by FORCE RLS instead of reporting a partial/empty rotation.
    await tx.$executeRaw`SET LOCAL row_security=off`;
    await tx.$executeRaw`LOCK TABLE public.users,public.invitation_mails,public.password_recoveries,public.password_recovery_requests IN ACCESS EXCLUSIVE MODE`;
    const secrets = await tx.$queryRaw<{ id: string; tenant_id: string; secret: string }[]>`SELECT id,tenant_id,mfa_secret AS secret FROM users WHERE mfa_secret IS NOT NULL`;
    const invitations = await tx.$queryRaw<{ id: string; tenant_id: string; user_id: string; secret: string }[]>`SELECT id,tenant_id,user_id,encrypted_url AS secret FROM invitation_mails WHERE encrypted_url IS NOT NULL`;
    const recoveries = await tx.$queryRaw<{ id: string; tenant_id: string; user_id: string; secret: string }[]>`SELECT id,tenant_id,user_id,encrypted_url AS secret FROM password_recoveries WHERE encrypted_url IS NOT NULL`;
    const requests=await tx.$queryRaw<{id:string;secret:string}[]>`SELECT id,encrypted_request AS secret FROM password_recovery_requests WHERE encrypted_request IS NOT NULL`;
    const reencrypt = (secret: string,identity: string) => {
      const plain=decryptSecret(secret,identity,oldKey), encrypted=encryptSecret(plain,identity,newKey);
      if (decryptSecret(encrypted,identity,newKey)!==plain) throw new Error('New encryption key verification failed');
      return encrypted;
    };
    for (const row of secrets) {
      const encrypted=reencrypt(row.secret,`${row.tenant_id}:${row.id}`);
      if (apply) await tx.$executeRaw`UPDATE users SET mfa_secret=${encrypted} WHERE id=${row.id}::uuid AND tenant_id=${row.tenant_id}::uuid`;
    }
    for (const row of invitations) {
      const encrypted=reencrypt(row.secret,`invitation:${row.tenant_id}:${row.user_id}`);
      if (apply) await tx.$executeRaw`UPDATE invitation_mails SET encrypted_url=${encrypted} WHERE id=${row.id}::uuid AND tenant_id=${row.tenant_id}::uuid`;
    }
    for (const row of recoveries) {
      const encrypted=reencrypt(row.secret,`recovery:${row.tenant_id}:${row.user_id}:${row.id}`);
      if (apply) await tx.$executeRaw`UPDATE password_recoveries SET encrypted_url=${encrypted} WHERE id=${row.id}::uuid AND tenant_id=${row.tenant_id}::uuid`;
    }
    for(const row of requests){
      const encrypted=reencrypt(row.secret,`recovery-request:${row.id}`);
      if(apply)await tx.$executeRaw`UPDATE password_recovery_requests SET encrypted_request=${encrypted} WHERE id=${row.id}::uuid`;
    }
    return { applied: apply, mfaSecrets: secrets.length, invitationLinks: invitations.length, recoveryLinks: recoveries.length,recoveryRequests:requests.length };
  }, { maxWait: 10000, timeout: 120000 });
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  try {
    if (!args.includes('--offline') || args.some(arg=>!['--offline','--apply'].includes(arg)) || !process.env.MIGRATION_DATABASE_URL) throw new Error('Usage: node dist/key-rotation.js --offline [--apply]');
    const db=new PrismaClient({ datasourceUrl: process.env.MIGRATION_DATABASE_URL, log: [] });
    try { console.info(JSON.stringify(await rotateEncryptionKey(db,process.env.MFA_ENCRYPTION_KEY??'',process.env.MFA_NEW_ENCRYPTION_KEY??'',args.includes('--apply')))); } finally { await db.$disconnect(); }
  } catch { console.error('Key rotation failed; the transaction was rolled back. Check maintenance mode, owner connection, old/new keys and encrypted data. Keys are never printed.'); process.exitCode=1; }
}
