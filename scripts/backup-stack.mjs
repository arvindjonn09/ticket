import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import console from "node:console";
import process from "node:process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backupRoot = resolve(workspace, ".local-backups");
const magic = Buffer.from("ASTRAMA-BACKUP-1\n");
const format = "astrama-stack-backup-v1";
const resourcePattern = /^astrama-restore-[a-f0-9]{32}-(network|db|files|pg|storage|api|copy)$/;
const names = ["database.dump.enc", "storage.tar.enc", "secrets.json.enc"];
const children = new Set();
let interrupted = false,
  cleaningUp = false;

export function validKey(value) {
  if (!/^[a-f0-9]{64}$/i.test(value ?? ""))
    throw new Error("A separate 64-character hexadecimal backup key is required");
  return Buffer.from(value, "hex");
}
export async function safeBackupPath(path) {
  const target = resolve(path),
    inside = relative(backupRoot, target);
  if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new Error("Backup paths must stay inside the workspace .local-backups directory");
  // Check every existing ancestor, including the workspace: no Windows junction
  // or symlink may redirect a generated write/cleanup outside the intended tree.
  let cursor = target;
  while (true) {
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error("Backup paths cannot contain links or junctions");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return target;
}
export async function encryptStream(source, path, key, identity) {
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
async function encryptJson(value, path, key, identity) {
  const { Readable } = await import("node:stream");
  await encryptStream(Readable.from([JSON.stringify(value)]), path, key, identity);
}
async function decryptJson(path, key, identity) {
  const { Writable } = await import("node:stream");
  const chunks = [];
  let size = 0;
  await decryptStream(
    path,
    new Writable({
      write(chunk, _encoding, done) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024)
          return done(new Error("Backup metadata exceeds the supported limit"));
        chunks.push(chunk);
        done();
      },
    }),
    key,
    identity,
  );
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest("hex");
}

function child(args, { env = {}, stdin = "pipe" } = {}) {
  if (interrupted && !cleaningUp) throw new Error("Backup interrupted");
  const process = spawn("docker", args, {
    cwd: workspace,
    env: { ...globalThis.process.env, ...env },
    stdio: [stdin, "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(process);
  process.once("close", () => children.delete(process));
  // Error text can contain connection strings. Never forward Docker/program stderr.
  let diagnostics = 0;
  process.stderr.on("data", (part) => {
    diagnostics += part.length;
  });
  const done = new Promise((accept, reject) => {
    process.once("error", () => reject(new Error(`Docker ${args[2] ?? args[0]} could not start`)));
    process.once("close", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              `Docker ${args.includes("pg_restore") ? "pg_restore" : args.includes("pg_dump") ? "pg_dump" : (args[2] ?? args[0])} failed (${code}; ${diagnostics} diagnostic bytes withheld)`,
            ),
          ),
    );
  });
  done.catch(() => {});
  return { process, done };
}
async function run(args, options = {}) {
  const task = child(args, options),
    parts = [];
  let length = 0;
  task.process.stdout.on("data", (part) => {
    length += part.length;
    if (length > 32 * 1024 * 1024) task.process.kill();
    else parts.push(part);
  });
  task.process.stdin?.end(options.input);
  await task.done;
  return Buffer.concat(parts).toString("utf8").trim();
}

async function dockerContext(requested) {
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
    throw new Error(
      "Unset Docker endpoint/context environment overrides; select a local Docker context explicitly",
    );
  const name = requested ?? (await run(["context", "show"]));
  const [context] = JSON.parse(await run(["context", "inspect", name]));
  if (!/^(unix:\/\/\/|npipe:\/{4}\.\/pipe\/)/.test(context?.Endpoints?.docker?.Host ?? ""))
    throw new Error("A local Unix socket or Windows named-pipe Docker context is required");
  return ["--context", name];
}
export async function secure(path, directory = false) {
  if (process.platform === "win32") {
    await new Promise((accept, reject) => {
      // Replace the DACL: icacls /grant:r alone leaves unrelated explicit ACEs.
      // Persist only the DACL. Set-Acl with a fresh owner/audit descriptor can
      // require SeSecurityPrivilege when replacing an existing directory ACL.
      const command =
        "$ErrorActionPreference='Stop';$path=$env:ASTRAMA_BACKUP_PRIVATE_PATH;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $path;if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Backup path must be owned by the current user'};if($env:ASTRAMA_BACKUP_DIRECTORY -eq 'true'){$sddl='D:P(A;OICI;FA;;;'+$sid.Value+')';$acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access);[IO.Directory]::SetAccessControl($path,$acl)}else{$sddl='D:P(A;;FA;;;'+$sid.Value+')';$acl.SetSecurityDescriptorSddlForm($sddl,[Security.AccessControl.AccessControlSections]::Access);[IO.File]::SetAccessControl($path,$acl)}";
      const acl = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
        stdio: "ignore",
        windowsHide: true,
        env: {
          ...process.env,
          ASTRAMA_BACKUP_PRIVATE_PATH: path,
          ASTRAMA_BACKUP_DIRECTORY: String(directory),
        },
      });
      acl.once("error", reject);
      acl.once("close", (code) =>
        code === 0 ? accept() : reject(new Error("Cannot restrict backup path permissions")),
      );
    });
  } else await chmod(path, directory ? 0o700 : 0o600);
}
export async function privateKeyFile(path) {
  const information = await lstat(path);
  if (information.isSymbolicLink() || !information.isFile())
    throw new Error("Backup key must be a regular private file");
  if (process.platform !== "win32") {
    if (
      (information.mode & 0o077) !== 0 ||
      information.uid !== process.getuid() ||
      ((await lstat(dirname(path))).mode & 0o022) !== 0
    )
      throw new Error(
        "Backup key must be owned by the current user, mode 0600 or stricter, inside a directory others cannot write",
      );
    return;
  }
  await new Promise((accept, reject) => {
    const command =
      "$ErrorActionPreference='Stop';$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath $env:ASTRAMA_BACKUP_PRIVATE_PATH;if(-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){exit 1};foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value){exit 1}};$parent=Get-Acl -LiteralPath ([IO.Path]::GetDirectoryName($env:ASTRAMA_BACKUP_PRIVATE_PATH));foreach($rule in $parent.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles)){exit 1}}";
    const check = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", command], {
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, ASTRAMA_BACKUP_PRIVATE_PATH: path },
    });
    check.once("error", reject);
    check.once("close", (code) =>
      code === 0
        ? accept()
        : reject(
            new Error(
              "Existing backup key ACL must allow only the current owner and its parent must prevent deletion by others",
            ),
          ),
    );
  });
}
async function backupKey(options) {
  if (process.env.BACKUP_ENCRYPTION_KEY) return validKey(process.env.BACKUP_ENCRYPTION_KEY);
  const path = resolve(process.env.BACKUP_KEY_FILE ?? resolve(backupRoot, "private-backup-key"));
  if (options["init-key"]) {
    await safeBackupPath(path);
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await secure(backupRoot, true);
    try {
      await writeFile(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
      await secure(path);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  await privateKeyFile(path);
  return validKey((await readFile(path, "utf8")).trim());
}

// Run only inside the already-built API image. No SMTP, workers or HTTP server
// start in the isolated restore network. Secrets enter via environment, not argv.
const runtimeScript = String.raw`
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
const apiRoot=existsSync('/app/apps/api/dist/mfa.js')?'/app/apps/api':'/app';
const require=createRequire(apiRoot+'/package.json');
const { PrismaClient }=require('@prisma/client');
const { S3Client, ListBucketsCommand, ListObjectsV2Command, GetObjectCommand, PutObjectCommand, DeleteObjectCommand }=require('@aws-sdk/client-s3');
const { encryptSecret, decryptSecret }=await import(apiRoot+'/dist/mfa.js');
const db = new PrismaClient({ datasourceUrl: process.env.BACKUP_DB_URL, log: [] });
const s3 = new S3Client({ endpoint: process.env.S3_ENDPOINT, region:'us-east-1', forcePathStyle:true, credentials:{accessKeyId:process.env.S3_ACCESS_KEY,secretAccessKey:process.env.S3_SECRET_KEY}, maxAttempts:3 });
const fixture = JSON.parse(process.env.BACKUP_FIXTURE ?? 'null');
const action = process.env.BACKUP_ACTION;
const digest = value => createHash('sha256').update(value).digest('hex');
try {
 if(action==='seed') {
  if(!/^backup-verify-[a-f0-9]{32}$/.test(fixture.slug)||!fixture.objectKey.startsWith('_backup-verification/')) throw new Error('Unsafe fixture identity');
  await db.$transaction(async tx=> {
   await tx.tenant.create({data:{id:fixture.tenantId,slug:fixture.slug,name:'Temporary backup verification fixture',brandName:'Astrama'}});
   await tx.user.create({data:{id:fixture.userId,tenantId:fixture.tenantId,name:'Backup verification fixture',email:'backup-fixture@example.invalid',role:'admin',passwordHash:'disabled',mfaEnrolled:true,mfaSecret:encryptSecret('JBSWY3DPEHPK3PXP',fixture.tenantId+':'+fixture.userId)}});
   await tx.invitationMail.create({data:{id:fixture.invitationId,tenantId:fixture.tenantId,userId:fixture.userId,invitationHash:digest(fixture.invitationId),encryptedUrl:encryptSecret('http://backup.invalid/invitation/'+fixture.invitationId,'invitation:'+fixture.tenantId+':'+fixture.userId)}});
   await tx.$executeRawUnsafe('INSERT INTO password_recoveries(id,tenant_id,user_id,token_hash,password_hash,email,expires_at,encrypted_url) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,now()+interval \'30 minutes\',$7)',fixture.recoveryId,fixture.tenantId,fixture.userId,digest(fixture.recoveryId),'disabled','backup-fixture@example.invalid',encryptSecret('http://backup.invalid/recovery/'+fixture.recoveryId,'recovery:'+fixture.tenantId+':'+fixture.userId+':'+fixture.recoveryId));
   await tx.$executeRawUnsafe('INSERT INTO password_recovery_requests(id,encrypted_request) VALUES($1::uuid,$2)',fixture.requestId,encryptSecret(JSON.stringify({organisation:fixture.slug,email:'backup-fixture@example.invalid'}),'recovery-request:'+fixture.requestId));
  });
  await s3.send(new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:fixture.objectKey,Body:Buffer.from(fixture.objectBytes,'base64'),ContentType:'application/octet-stream'}));
  console.log(JSON.stringify({seeded:true}));
 } else if(action==='cleanup') {
  if(!/^backup-verify-[a-f0-9]{32}$/.test(fixture.slug)||!fixture.objectKey.startsWith('_backup-verification/')) throw new Error('Unsafe fixture identity');
  const tenant=await db.tenant.findFirst({where:{id:fixture.tenantId,slug:fixture.slug}});
  if(tenant) await db.$transaction(async tx=> {
   await tx.$executeRawUnsafe('DELETE FROM password_recoveries WHERE tenant_id=$1::uuid',fixture.tenantId);
   await tx.invitationMail.deleteMany({where:{tenantId:fixture.tenantId}});
   await tx.user.deleteMany({where:{tenantId:fixture.tenantId}});
   await tx.tenant.delete({where:{id:fixture.tenantId}});
  });
  await db.$executeRawUnsafe('DELETE FROM password_recovery_requests WHERE id=$1::uuid',fixture.requestId);
  await s3.send(new DeleteObjectCommand({Bucket:process.env.S3_BUCKET,Key:fixture.objectKey}));
  console.log(JSON.stringify({cleaned:true}));
 } else if(action==='snapshot') {
  const counts={};
  const tables=await db.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename");
  for(const {tablename} of tables) {
   if(!/^[a-z_][a-z0-9_]*$/.test(tablename)) throw new Error('Unsupported public table name');
   counts[tablename]=String((await db.$queryRawUnsafe('SELECT count(*) AS total FROM public."'+tablename+'"'))[0].total);
  }
  const secrets={mfa:0,invitations:0,recoveries:0,recoveryRequests:0};
  for(const row of await db.user.findMany({where:{mfaSecret:{not:null}},select:{id:true,tenantId:true,mfaSecret:true}})) {
   const value=decryptSecret(row.mfaSecret,row.tenantId+':'+row.id); secrets.mfa++;
   if(fixture && row.id===fixture.userId && value!=='JBSWY3DPEHPK3PXP') throw new Error('Restored MFA fixture differs');
  }
  for(const row of await db.invitationMail.findMany({where:{encryptedUrl:{not:null}}})) {
   const value=decryptSecret(row.encryptedUrl,'invitation:'+row.tenantId+':'+row.userId); secrets.invitations++;
   if(fixture && row.id===fixture.invitationId && value!=='http://backup.invalid/invitation/'+fixture.invitationId) throw new Error('Restored invitation fixture differs');
  }
  for(const row of await db.$queryRawUnsafe('SELECT id,tenant_id,user_id,encrypted_url FROM password_recoveries WHERE encrypted_url IS NOT NULL')) {
   const value=decryptSecret(row.encrypted_url,'recovery:'+row.tenant_id+':'+row.user_id+':'+row.id); secrets.recoveries++;
   if(fixture && row.id===fixture.recoveryId && value!=='http://backup.invalid/recovery/'+fixture.recoveryId) throw new Error('Restored recovery fixture differs');
  }
  for(const row of await db.$queryRawUnsafe('SELECT id,encrypted_request FROM password_recovery_requests WHERE encrypted_request IS NOT NULL')) {
   const value=JSON.parse(decryptSecret(row.encrypted_request,'recovery-request:'+row.id)); secrets.recoveryRequests++;
   if(typeof value.organisation!=='string'||typeof value.email!=='string') throw new Error('Invalid restored recovery request');
   if(fixture && row.id===fixture.requestId && (value.organisation!==fixture.slug||value.email!=='backup-fixture@example.invalid')) throw new Error('Restored recovery request fixture differs');
  }
  const objects=[];
  for(const bucket of (await s3.send(new ListBucketsCommand({}))).Buckets??[]) {
   let cursor;
   do {
    const list=await s3.send(new ListObjectsV2Command({Bucket:bucket.Name,ContinuationToken:cursor}));
    for(const object of list.Contents??[]) {
     const result=await s3.send(new GetObjectCommand({Bucket:bucket.Name,Key:object.Key})), hash=createHash('sha256'); let size=0;
     for await(const part of result.Body) {hash.update(part);size+=part.length;}
     objects.push({bucket:bucket.Name,key:object.Key,size,sha256:hash.digest('hex')});
    }
    cursor=list.IsTruncated?list.NextContinuationToken:undefined;
    if(list.IsTruncated&&!cursor) throw new Error('Incomplete object listing');
   } while(cursor);
  }
  objects.sort((a,b)=>(a.bucket+'\0'+a.key).localeCompare(b.bucket+'\0'+b.key));
  if(fixture) {
   const object=objects.find(o=>o.bucket===process.env.S3_BUCKET&&o.key===fixture.objectKey);
   if(!object || object.sha256!==digest(Buffer.from(fixture.objectBytes,'base64'))) throw new Error('Backup object byte hash differs');
   const url=process.env.S3_ENDPOINT+'/'+encodeURIComponent(process.env.S3_BUCKET)+'/'+fixture.objectKey.split('/').map(encodeURIComponent).join('/');
   const response=await fetch(url);
   if(response.status!==403&&response.status!==401) throw new Error('Private object is accessible without authentication');
  }
  console.log(JSON.stringify({counts,secrets,objects}));
 } else if(action==='heartbeat') {
  await db.$executeRawUnsafe("INSERT INTO operation_heartbeats(component,checked_at,successful) VALUES('backup',now(),true) ON CONFLICT(component) DO UPDATE SET checked_at=EXCLUDED.checked_at,successful=true");
  console.log(JSON.stringify({recorded:true}));
 } else throw new Error('Unknown backup helper action');
} finally {s3.destroy();await db.$disconnect();}
`;

function envMap(container) {
  return Object.fromEntries(
    container.Config.Env.map((value) => {
      const index = value.indexOf("=");
      return [value.slice(0, index), value.slice(index + 1)];
    }),
  );
}
async function sourceStack(docker, options) {
  const compose = resolve(workspace, options.compose ?? "compose.yaml"),
    project = options.project ?? "astrama-local";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error("Invalid Compose project");
  const composePath = relative(workspace, await realpath(compose));
  if (composePath.startsWith("..") || isAbsolute(composePath))
    throw new Error("Compose file must be inside this workspace");
  const composeEnvironment = [];
  if (options["env-file"]) {
    const path = await realpath(resolve(workspace, options["env-file"])),
      inside = relative(workspace, path);
    if (inside.startsWith("..") || isAbsolute(inside))
      throw new Error("Compose environment file must be inside this workspace");
    composeEnvironment.push("--env-file", path);
  }
  const services = {};
  for (const name of ["db", "storage", "api", "worker", "web"]) {
    const id = await run([
      ...docker,
      "compose",
      ...composeEnvironment,
      "-f",
      compose,
      "-p",
      project,
      "ps",
      "-a",
      "-q",
      name,
    ]);
    if (!id || id.includes("\n"))
      throw new Error(`Exactly one ${name} Compose service is required`);
    const [container] = JSON.parse(await run([...docker, "inspect", id]));
    if (
      container.Config.Labels?.["com.docker.compose.project"] !== project ||
      container.Config.Labels?.["com.docker.compose.service"] !== name ||
      resolve(container.Config.Labels?.["com.docker.compose.project.working_dir"] ?? "") !==
        workspace
    )
      throw new Error("Compose service identity or workspace differs");
    services[name] = container;
  }
  if (
    !services.db.State.Running ||
    !services.storage.State.Running ||
    !/^postgres:16(?:-|@|$)/.test(services.db.Config.Image) ||
    !/^rustfs\/rustfs(?:[:@])/.test(services.storage.Config.Image)
  )
    throw new Error("Expected running local PostgreSQL 16 and RustFS services");
  const mount = services.storage.Mounts.find((value) => value.Destination === "/data");
  if (!mount || mount.Type !== "volume" || !mount.Name)
    throw new Error("RustFS /data must use a named volume");
  const [volume] = JSON.parse(await run([...docker, "volume", "inspect", mount.Name]));
  if (volume.Labels?.["com.docker.compose.project"] !== project)
    throw new Error("RustFS volume belongs to another Compose project");
  const api = envMap(services.api),
    storage = envMap(services.storage),
    database = envMap(services.db);
  const owner = database.POSTGRES_USER,
    databaseName = database.POSTGRES_DB;
  if (
    !/^[a-z_][a-z0-9_]*$/.test(owner ?? "") ||
    !/^[a-z_][a-z0-9_]*$/.test(databaseName ?? "") ||
    owner !== "astrama_owner"
  )
    throw new Error("Expected the explicit Astrama migration owner and database");
  const network = Object.keys(services.api.NetworkSettings.Networks).find(
    (name) =>
      name in services.db.NetworkSettings.Networks &&
      name in services.storage.NetworkSettings.Networks,
  );
  if (!network) throw new Error("API, database and storage must share a Compose network");
  const mfa = validKey(api.MFA_ENCRYPTION_KEY);
  const secrets = {
    mfaEncryptionKey: mfa.toString("hex"),
    s3AccessKey: storage.RUSTFS_ACCESS_KEY,
    s3SecretKey: storage.RUSTFS_SECRET_KEY,
    s3Bucket: api.S3_BUCKET,
    owner,
    databaseName,
  };
  if (!secrets.s3AccessKey || !secrets.s3SecretKey || !secrets.s3Bucket)
    throw new Error("Storage credentials and private bucket are required");
  const ownerUrl = new URL(`postgresql://${owner}@db:5432/${databaseName}`);
  ownerUrl.password = database.POSTGRES_PASSWORD;
  return {
    services,
    network,
    volume: mount.Name,
    ownerUrl: ownerUrl.toString(),
    secrets,
    images: {
      api: services.api.Image,
      postgres: services.db.Image,
      storage: services.storage.Image,
    },
  };
}

async function runtime(docker, image, network, secrets, databaseUrl, action, fixture, identity) {
  const name = `astrama-restore-${identity}-api`;
  const environment = {
    BACKUP_DB_URL: databaseUrl,
    BACKUP_ACTION: action,
    BACKUP_FIXTURE: JSON.stringify(fixture ?? null),
    MFA_ENCRYPTION_KEY: secrets.mfaEncryptionKey,
    S3_ENDPOINT: "http://storage:9000",
    S3_BUCKET: secrets.s3Bucket,
    S3_ACCESS_KEY: secrets.s3AccessKey,
    S3_SECRET_KEY: secrets.s3SecretKey,
  };
  const output = await run(
    [
      ...docker,
      "run",
      "--rm",
      "-i",
      "--name",
      name,
      "--label",
      `astrama.backup.verify=${identity}`,
      "--network",
      network,
      "--workdir",
      "/app",
      ...Object.keys(environment).flatMap((key) => ["-e", key]),
      image,
      "node",
      "--input-type=module",
    ],
    { env: environment, input: runtimeScript },
  );
  return JSON.parse(output);
}
async function waitDatabase(docker, name, owner, databaseName) {
  for (let attempt = 0; attempt < 60; attempt++) {
    // The image's temporary initialization server accepts Unix sockets before
    // it shuts down again. TCP is ready only after the final server starts.
    try {
      await run([
        ...docker,
        "exec",
        name,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        owner,
        "-d",
        databaseName,
      ]);
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Isolated PostgreSQL did not become ready");
}
async function waitStorage(docker, image, network, secrets, databaseUrl, fixture, id) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await runtime(docker, image, network, secrets, databaseUrl, "snapshot", fixture, id);
    } catch {
      await sleep(500);
    }
  }
  throw new Error("Storage, restored data or recovered encryption keys failed verification");
}
async function removeResource(docker, type, name, id) {
  if (!resourcePattern.test(name) || !name.startsWith(`astrama-restore-${id}-`))
    throw new Error("Unsafe generated Docker cleanup identity");
  // A failed inspect may mean a disconnected daemon, not an absent resource.
  // Only a successful listing can establish absence; every other error fails cleanup.
  const listed = await run([
    ...docker,
    type,
    "ls",
    ...(type === "container" ? ["-a"] : []),
    "--filter",
    `name=${name}`,
    "--format",
    type === "container" ? "{{.Names}}" : "{{.Name}}",
  ]);
  if (!listed.split(/\r?\n/).includes(name)) return;
  const [resource] = JSON.parse(
    await run([
      ...docker,
      type === "container" ? "inspect" : type,
      ...(type === "container" ? [] : ["inspect"]),
      name,
    ]),
  );
  const label =
    type === "container"
      ? resource.Config.Labels?.["astrama.backup.verify"]
      : resource.Labels?.["astrama.backup.verify"];
  if (label !== id)
    throw new Error("Refusing cleanup of a Docker resource without the generated backup label");
  await run([
    ...docker,
    type === "container" ? "rm" : type,
    ...(type === "container" ? ["-f"] : ["rm"]),
    name,
  ]);
}

export async function verifyBackup(docker, directory, key) {
  await safeBackupPath(directory);
  const manifest = await decryptJson(resolve(directory, "manifest.json.enc"), key, "manifest");
  if (
    manifest.format !== format ||
    !manifest.images ||
    !manifest.snapshot ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== names.length
  )
    throw new Error("Invalid authenticated backup manifest");
  for (const name of names) {
    const expected = manifest.artifacts.find((artifact) => artifact.name === name);
    const path = await safeBackupPath(resolve(directory, name));
    if (!expected || expected.sha256 !== (await hashFile(path)))
      throw new Error("Encrypted artifact SHA-256 differs from the authenticated manifest");
  }
  const secrets = await decryptJson(resolve(directory, "secrets.json.enc"), key, "secrets");
  validKey(secrets.mfaEncryptionKey);
  const id = randomUUID().replaceAll("-", ""),
    prefix = `astrama-restore-${id}`;
  const network = `${prefix}-network`,
    dbVolume = `${prefix}-db`,
    filesVolume = `${prefix}-files`,
    pg = `${prefix}-pg`,
    storage = `${prefix}-storage`;
  const ownerPassword = randomBytes(32).toString("hex"),
    appPassword = randomBytes(32).toString("hex");
  const ownerUrl = new URL(`postgresql://${secrets.owner}@db:5432/${secrets.databaseName}`);
  ownerUrl.password = ownerPassword;
  const label = `astrama.backup.verify=${id}`;
  const artifacts = [],
    cleanupErrors = [];
  let verification, primaryError;
  try {
    for (const [type, name, extra] of [
      ["network", network, ["--internal"]],
      ["volume", dbVolume, []],
      ["volume", filesVolume, []],
    ]) {
      await run([...docker, type, "create", ...extra, "--label", label, name]);
      artifacts.push([type, name]);
    }
    await run(
      [
        ...docker,
        "run",
        "-d",
        "--name",
        pg,
        "--label",
        label,
        "--network",
        network,
        "--network-alias",
        "db",
        "--mount",
        `type=volume,source=${dbVolume},target=/var/lib/postgresql/data`,
        "-e",
        `POSTGRES_USER=${secrets.owner}`,
        "-e",
        `POSTGRES_DB=${secrets.databaseName}`,
        "-e",
        "POSTGRES_PASSWORD",
        manifest.images.postgres,
      ],
      { env: { POSTGRES_PASSWORD: ownerPassword } },
    );
    artifacts.push(["container", pg]);
    await waitDatabase(docker, pg, secrets.owner, secrets.databaseName);
    await run(
      [
        ...docker,
        "exec",
        "-i",
        pg,
        "psql",
        "-U",
        secrets.owner,
        "-d",
        secrets.databaseName,
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        input: `CREATE ROLE astrama_app LOGIN PASSWORD '${appPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;\nCREATE ROLE astrama_auth_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;\n`,
      },
    );
    const restore = child([
      ...docker,
      "exec",
      "-i",
      pg,
      "pg_restore",
      "-U",
      secrets.owner,
      "-d",
      secrets.databaseName,
      "--exit-on-error",
    ]);
    restore.process.stdout.resume();
    try {
      await Promise.all([
        decryptStream(
          resolve(directory, "database.dump.enc"),
          restore.process.stdin,
          key,
          "database",
        ),
        restore.done,
      ]);
    } catch (error) {
      restore.process.kill();
      throw error;
    }
    const unpack = child([
      ...docker,
      "run",
      "--rm",
      "-i",
      "--name",
      `${prefix}-copy`,
      "--label",
      label,
      "--network",
      "none",
      "--mount",
      `type=volume,source=${filesVolume},target=/data`,
      manifest.images.postgres,
      "tar",
      "-C",
      "/data",
      "-xf",
      "-",
    ]);
    unpack.process.stdout.resume();
    try {
      await Promise.all([
        decryptStream(resolve(directory, "storage.tar.enc"), unpack.process.stdin, key, "storage"),
        unpack.done,
      ]);
    } catch (error) {
      unpack.process.kill();
      throw error;
    }
    await run(
      [
        ...docker,
        "run",
        "-d",
        "--name",
        storage,
        "--label",
        label,
        "--network",
        network,
        "--network-alias",
        "storage",
        "--mount",
        `type=volume,source=${filesVolume},target=/data`,
        "-e",
        "RUSTFS_ACCESS_KEY",
        "-e",
        "RUSTFS_SECRET_KEY",
        "-e",
        "RUSTFS_ADDRESS=:9000",
        "-e",
        "RUSTFS_CONSOLE_ENABLE=false",
        manifest.images.storage,
        "/data",
      ],
      { env: { RUSTFS_ACCESS_KEY: secrets.s3AccessKey, RUSTFS_SECRET_KEY: secrets.s3SecretKey } },
    );
    artifacts.push(["container", storage]);
    const restored = await waitStorage(
      docker,
      manifest.images.api,
      network,
      secrets,
      ownerUrl.toString(),
      manifest.fixture,
      id,
    );
    if (JSON.stringify(restored) !== JSON.stringify(manifest.snapshot))
      throw new Error(
        "Restored table counts, object byte hashes or decryptable secret counts differ",
      );
    const appUrl = new URL(ownerUrl);
    appUrl.username = "astrama_app";
    appUrl.password = appPassword;
    // Verify the restored runtime role remains restricted and missing RLS context denies business data.
    const runtimeCheck = String.raw`import {existsSync} from 'node:fs';const root=existsSync('/app/apps/api/dist/database.js')?'/app/apps/api':'/app';const {Database}=await import(root+'/dist/database.js');const db=new Database();try{await db.assertRuntimeRole();if(await db.ticket.count()!==0)throw new Error('Missing-context RLS failed');console.log('restricted');}finally{await db.$disconnect();}`;
    const result = await run(
      [
        ...docker,
        "run",
        "--rm",
        "-i",
        "--name",
        `${prefix}-api`,
        "--label",
        label,
        "--network",
        network,
        "--workdir",
        "/app",
        "-e",
        "DATABASE_URL",
        manifest.images.api,
        "node",
        "--input-type=module",
      ],
      { env: { DATABASE_URL: appUrl.toString() }, input: runtimeCheck },
    );
    if (result !== "restricted") throw new Error("Restored runtime role verification failed");
    verification = {
      directory,
      verifiedAt: new Date().toISOString(),
      publicTables: Object.keys(restored.counts).length,
      objects: restored.objects.length,
      decryptedSecrets: restored.secrets,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    cleaningUp = true;
    // Only generated names with our UUID label are eligible for removal. No live
    // container/volume is ever a restore destination or cleanup target.
    for (const name of [`${prefix}-api`, `${prefix}-copy`])
      try {
        await removeResource(docker, "container", name, id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    for (const [type, name] of artifacts.reverse())
      try {
        await removeResource(docker, type, name, id);
      } catch (error) {
        cleanupErrors.push(error);
      }
    cleaningUp = false;
  }
  if (cleanupErrors.length)
    throw new Error(
      "Generated isolated restore resources require manual cleanup by backup UUID label",
    );
  if (primaryError) throw primaryError;
  return verification;
}

async function captureBackup(docker, options, key) {
  const stack = await sourceStack(docker, options);
  if (timingSafeEqual(key, validKey(stack.secrets.mfaEncryptionKey)))
    throw new Error("Backup encryption key must differ from the application MFA key");
  const id = randomUUID().replaceAll("-", ""),
    directory = await safeBackupPath(
      resolve(backupRoot, `backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${id}`),
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await secure(directory, true);
  const fixture = {
    slug: `backup-verify-${id}`,
    tenantId: randomUUID(),
    userId: randomUUID(),
    invitationId: randomUUID(),
    recoveryId: randomUUID(),
    requestId: randomUUID(),
    objectKey: `_backup-verification/${id}.bin`,
    objectBytes: randomBytes(4096).toString("base64"),
  };
  const appContainers = ["web", "api", "worker"]
    .map((name) => stack.services[name])
    .filter((container) => container.State.Running)
    .map((container) => container.Id);
  let storageStopped = false,
    seeded = false,
    primaryError;
  const recoveryErrors = [];
  try {
    console.info(
      "Quiescing the local application, worker and private object store for a consistent snapshot.",
    );
    if (appContainers.length) await run([...docker, "stop", "--time", "30", ...appContainers]);
    // Set before creation so a partial fixture failure is still cleaned safely.
    seeded = true;
    await runtime(
      docker,
      stack.images.api,
      stack.network,
      stack.secrets,
      stack.ownerUrl,
      "seed",
      fixture,
      id,
    );
    const snapshot = await runtime(
      docker,
      stack.images.api,
      stack.network,
      stack.secrets,
      stack.ownerUrl,
      "snapshot",
      fixture,
      id,
    );
    storageStopped = true;
    await run([...docker, "stop", "--time", "30", stack.services.storage.Id]);
    const dump = child([
      ...docker,
      "exec",
      stack.services.db.Id,
      "pg_dump",
      "-U",
      stack.secrets.owner,
      "-d",
      stack.secrets.databaseName,
      "-Fc",
    ]);
    dump.process.stdin.end();
    try {
      await Promise.all([
        encryptStream(dump.process.stdout, resolve(directory, names[0]), key, "database"),
        dump.done,
      ]);
    } catch (error) {
      dump.process.kill();
      throw error;
    }
    const files = child([
      ...docker,
      "run",
      "--rm",
      "--name",
      `astrama-restore-${id}-copy`,
      "--label",
      `astrama.backup.verify=${id}`,
      "--network",
      "none",
      "--mount",
      `type=volume,source=${stack.volume},target=/data,readonly`,
      stack.images.postgres,
      "tar",
      "-C",
      "/data",
      "-cf",
      "-",
      ".",
    ]);
    files.process.stdin.end();
    try {
      await Promise.all([
        encryptStream(files.process.stdout, resolve(directory, names[1]), key, "storage"),
        files.done,
      ]);
    } catch (error) {
      files.process.kill();
      throw error;
    }
    await encryptJson(stack.secrets, resolve(directory, names[2]), key, "secrets");
    const manifest = {
      format,
      capturedAt: new Date().toISOString(),
      images: stack.images,
      fixture,
      snapshot,
      artifacts: await Promise.all(
        names.map(async (name) => ({ name, sha256: await hashFile(resolve(directory, name)) })),
      ),
    };
    await encryptJson(manifest, resolve(directory, "manifest.json.enc"), key, "manifest");
  } catch (error) {
    primaryError = error;
  } finally {
    cleaningUp = true;
    for (const suffix of ["api", "copy"])
      try {
        await removeResource(docker, "container", `astrama-restore-${id}-${suffix}`, id);
      } catch (error) {
        recoveryErrors.push(error);
      }
    if (storageStopped)
      try {
        await run([...docker, "start", stack.services.storage.Id]);
      } catch (error) {
        recoveryErrors.push(error);
      }
    if (seeded) {
      let cleaned = false;
      for (let attempt = 0; attempt < 30 && !cleaned; attempt++) {
        try {
          await runtime(
            docker,
            stack.images.api,
            stack.network,
            stack.secrets,
            stack.ownerUrl,
            "cleanup",
            fixture,
            id,
          );
          cleaned = true;
        } catch {
          await sleep(500);
        }
      }
      if (!cleaned)
        recoveryErrors.push(new Error("Temporary source backup fixture cleanup failed"));
    }
    if (appContainers.length)
      try {
        await run([...docker, "start", ...appContainers]);
      } catch (error) {
        recoveryErrors.push(error);
      }
    cleaningUp = false;
  }
  if (recoveryErrors.length)
    throw new Error(
      "Backup failed to restore the original running services or remove the temporary source fixture; inspect the generated backup UUID",
    );
  if (primaryError) throw primaryError;
  if (interrupted) throw new Error("Backup interrupted after restoring live services");
  console.info(
    "Encrypted snapshot captured; live services restored. Verifying in a new isolated PostgreSQL/RustFS network.",
  );
  const verification = await verifyBackup(docker, directory, key);
  // Success means a full restore passed, never merely that a dump file exists.
  await runtime(
    docker,
    stack.images.api,
    stack.network,
    stack.secrets,
    stack.ownerUrl,
    "heartbeat",
    null,
    id,
  );
  await encryptJson(verification, resolve(directory, "verification.json.enc"), key, "verification");
  return verification;
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      verify: { type: "boolean" },
      "init-key": { type: "boolean" },
      backup: { type: "string" },
      context: { type: "string" },
      compose: { type: "string" },
      project: { type: "string" },
      "env-file": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.info(
      "backup-stack.mjs backup --verify [--init-key] [--compose compose.yaml] [--project astrama-local]\nbackup-stack.mjs restore --verify --backup .local-backups/backup-...\nUse BACKUP_ENCRYPTION_KEY or BACKUP_KEY_FILE; --init-key creates a private persistent local key once. Backups always verify a complete isolated restore.",
    );
    return;
  }
  if (
    positionals.length !== 1 ||
    !["backup", "restore"].includes(positionals[0]) ||
    (positionals[0] === "restore" && (!values.verify || !values.backup))
  )
    throw new Error("Use backup --verify, or restore --verify --backup <directory>");
  await safeBackupPath(backupRoot);
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await secure(backupRoot, true);
  const key = await backupKey(values),
    docker = await dockerContext(values.context);
  let lock;
  const lockPath = await safeBackupPath(resolve(backupRoot, "active-backup.lock"));
  if (positionals[0] === "backup") {
    try {
      lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(
        JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
      );
    } catch (error) {
      key.fill(0);
      if (error.code === "EEXIST")
        throw new Error(
          "Another backup owns .local-backups/active-backup.lock; after a crashed process, inspect service state before removing this stale lock",
        );
      throw error;
    }
  }
  const signal = () => {
    interrupted = true;
    if (!cleaningUp) for (const process of children) process.kill();
  };
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  try {
    const result =
      positionals[0] === "backup"
        ? await captureBackup(docker, values, key)
        : await verifyBackup(docker, await safeBackupPath(resolve(workspace, values.backup)), key);
    console.info(JSON.stringify({ event: "backup.restore_verified", ...result }));
  } finally {
    key.fill(0);
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    if (lock) {
      await lock.close();
      await unlink(await safeBackupPath(lockPath));
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(
      `Backup/recovery failed: ${error.message}. No secrets or program diagnostics are printed.`,
    );
    process.exitCode = 1;
  });
}
