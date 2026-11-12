import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

describe.skipIf(!process.env.MIGRATION_DATABASE_URL)('offline key rotation — disposable PostgreSQL database only',()=>{
  let owner: PrismaClient, isolated: PrismaClient;
  const database=`astrama_rotation_${randomUUID().replaceAll('-','')}`;
  const tenant=randomUUID(), user=randomUUID(), foreignTenant=randomUUID(), foreignUser=randomUUID(), invitation=randomUUID(), recovery=randomUUID(),request=randomUUID();
  const oldKey='ac'.repeat(32),newKey='bd'.repeat(32);
  let mfaCipher: string, invitationCipher: string, recoveryCipher: string;
  beforeAll(async()=>{
    owner=new PrismaClient({datasourceUrl:process.env.MIGRATION_DATABASE_URL});
    // Name is generated above from a UUID and fixed prefix, never operator-controlled SQL.
    await owner.$executeRawUnsafe(`CREATE DATABASE "${database}"`);
    const url=new URL(process.env.MIGRATION_DATABASE_URL!);url.pathname=`/${database}`;
    isolated=new PrismaClient({datasourceUrl:url.toString()});
    await isolated.$executeRaw`CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,mfa_secret text)`;
    await isolated.$executeRaw`CREATE TABLE invitation_mails(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,user_id uuid NOT NULL,encrypted_url text)`;
    await isolated.$executeRaw`CREATE TABLE password_recoveries(id uuid PRIMARY KEY,tenant_id uuid NOT NULL,user_id uuid NOT NULL,encrypted_url text)`;
    await isolated.$executeRaw`CREATE TABLE password_recovery_requests(id uuid PRIMARY KEY,encrypted_request text)`;
    const {encryptSecret,encryptionKey}=await import('../dist/mfa.js');
    mfaCipher=encryptSecret('JBSWY3DPEHPK3PXP',`${tenant}:${user}`,encryptionKey(oldKey));
    invitationCipher=encryptSecret('https://fixture.invalid/#activate?token=fixture',`invitation:${foreignTenant}:${foreignUser}`,encryptionKey(oldKey));
    recoveryCipher=encryptSecret('https://fixture.invalid/#reset-password?token=fixture',`recovery:${tenant}:${user}:${recovery}`,encryptionKey(oldKey));
    await isolated.$executeRaw`INSERT INTO users VALUES(${user}::uuid,${tenant}::uuid,${mfaCipher})`;
    await isolated.$executeRaw`INSERT INTO invitation_mails VALUES(${invitation}::uuid,${foreignTenant}::uuid,${foreignUser}::uuid,${invitationCipher})`;
    await isolated.$executeRaw`INSERT INTO password_recoveries VALUES(${recovery}::uuid,${tenant}::uuid,${user}::uuid,${recoveryCipher})`;
    await isolated.$executeRaw`INSERT INTO password_recovery_requests VALUES(${request}::uuid,${encryptSecret('{"organisation":"fixture","email":"fixture@test.invalid"}',`recovery-request:${request}`,encryptionKey(oldKey))})`;
  });
  afterAll(async()=>{
    await isolated?.$disconnect();
    if(owner){await owner.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${database}"`);await owner.$disconnect();}
  });
  it('validates distinct keys and dry-run without changing any ciphertext',async()=>{
    const {rotateEncryptionKey}=await import('../dist/key-rotation.js');
    await expect(rotateEncryptionKey(isolated,oldKey,'bad',true)).rejects.toThrow('64 hexadecimal');
    await expect(rotateEncryptionKey(isolated,oldKey,oldKey,true)).rejects.toThrow('differ');
    expect(await rotateEncryptionKey(isolated,oldKey,newKey)).toEqual({applied:false,mfaSecrets:1,invitationLinks:1,recoveryLinks:1,recoveryRequests:1});
    const [row]=await isolated.$queryRaw<{mfa_secret:string}[]>`SELECT mfa_secret FROM users WHERE id=${user}::uuid`;
    expect(row!.mfa_secret).toBe(mfaCipher);
  });
  it('rolls back all earlier replacements on invalid later ciphertext, then rotates every secret type',async()=>{
    const {rotateEncryptionKey}=await import('../dist/key-rotation.js');
    const {decryptSecret,encryptionKey}=await import('../dist/mfa.js');
    await isolated.$executeRaw`UPDATE password_recoveries SET encrypted_url='corrupt' WHERE id=${recovery}::uuid`;
    await expect(rotateEncryptionKey(isolated,oldKey,newKey,true)).rejects.toThrow();
    let [row]=await isolated.$queryRaw<{mfa_secret:string}[]>`SELECT mfa_secret FROM users WHERE id=${user}::uuid`;expect(row!.mfa_secret).toBe(mfaCipher);
    const [inviteUnchanged]=await isolated.$queryRaw<{encrypted_url:string}[]>`SELECT encrypted_url FROM invitation_mails WHERE id=${invitation}::uuid`;expect(inviteUnchanged!.encrypted_url).toBe(invitationCipher);
    await isolated.$executeRaw`UPDATE password_recoveries SET encrypted_url=${recoveryCipher} WHERE id=${recovery}::uuid`;
    expect((await rotateEncryptionKey(isolated,oldKey,newKey,true)).applied).toBe(true);
    [row]=await isolated.$queryRaw<{mfa_secret:string}[]>`SELECT mfa_secret FROM users WHERE id=${user}::uuid`;
    expect(decryptSecret(row!.mfa_secret,`${tenant}:${user}`,encryptionKey(newKey))).toBe('JBSWY3DPEHPK3PXP');
    expect(()=>decryptSecret(row!.mfa_secret,`${tenant}:${user}`,encryptionKey(oldKey))).toThrow();
    const [invite]=await isolated.$queryRaw<{encrypted_url:string}[]>`SELECT encrypted_url FROM invitation_mails WHERE id=${invitation}::uuid`;
    expect(decryptSecret(invite!.encrypted_url,`invitation:${foreignTenant}:${foreignUser}`,encryptionKey(newKey))).toContain('#activate?');
    const [reset]=await isolated.$queryRaw<{encrypted_url:string}[]>`SELECT encrypted_url FROM password_recoveries WHERE id=${recovery}::uuid`;
    expect(decryptSecret(reset!.encrypted_url,`recovery:${tenant}:${user}:${recovery}`,encryptionKey(newKey))).toContain('#reset-password?');
    const [queued]=await isolated.$queryRaw<{encrypted_request:string}[]>`SELECT encrypted_request FROM password_recovery_requests WHERE id=${request}::uuid`;
    expect(decryptSecret(queued!.encrypted_request,`recovery-request:${request}`,encryptionKey(newKey))).toContain('fixture@test.invalid');
    await expect(rotateEncryptionKey(isolated,oldKey,'ce'.repeat(32),true)).rejects.toThrow();
  });
});
