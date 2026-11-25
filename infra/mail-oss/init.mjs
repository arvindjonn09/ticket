import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile, chmod, chown, access, copyFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

const root = "/mox";
const domain = process.env.MAIL_OSS_DOMAIN || "astrama.localhost";
if (!/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(domain))
  throw new Error("MAIL_OSS_DOMAIN must be a lowercase DNS name");
const privateDir = `${root}/private`;
const caDir = "/mail-oss-ca";
await mkdir(privateDir, { recursive: true, mode: 0o700 });
await mkdir(`${root}/data`, { recursive: true, mode: 0o700 });
await mkdir(caDir, { recursive: true, mode: 0o755 });
for (const path of [root, privateDir, `${root}/data`]) {
  await chown(path, 1000, 1000);
  await chmod(path, 0o700);
}
const metadata = `${privateDir}/smtp-profile.json`;
try {
  const existing = JSON.parse(await readFile(metadata, "utf8"));
  if (existing.fromDomain !== domain)
    throw new Error("Existing OSS mail domain differs; use a fresh isolated project");
  await copyFile(`${privateDir}/ca.crt`, `${caDir}/ca.crt`);
  await chmod(`${caDir}/ca.crt`, 0o644);
  console.info("Existing private OSS mail configuration retained");
  process.exit(0);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function openssl(...args) {
  execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
}
process.umask(0o077);
openssl(
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-days",
  "3650",
  "-subj",
  "/CN=Astrama OSS testing CA",
  "-keyout",
  `${privateDir}/ca.key`,
  "-out",
  `${privateDir}/ca.crt`,
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,keyCertSign,cRLSign",
);
openssl(
  "req",
  "-new",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-subj",
  "/CN=mox",
  "-keyout",
  `${privateDir}/smtp.key`,
  "-out",
  `${privateDir}/smtp.csr`,
);
await writeFile(
  `${privateDir}/smtp.ext`,
  "subjectAltName=DNS:mox\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n",
  { mode: 0o600 },
);
openssl(
  "x509",
  "-req",
  "-in",
  `${privateDir}/smtp.csr`,
  "-CA",
  `${privateDir}/ca.crt`,
  "-CAkey",
  `${privateDir}/ca.key`,
  "-CAcreateserial",
  "-days",
  "825",
  "-extfile",
  `${privateDir}/smtp.ext`,
  "-out",
  `${privateDir}/smtp.crt`,
);
openssl("genpkey", "-algorithm", "ed25519", "-out", `${privateDir}/dkim.pem`);

function staticConfig(ip) {
  return `DataDir: /mox/data
LogLevel: error
User: 1000
NoFixPermissions: true
Hostname: mox
Postmaster:
\tAccount: platform
\tMailbox: Inbox
Listeners:
\tsubmission:
\t\tIPs:
\t\t\t- ${ip}
\t\tTLS:
\t\t\tKeyCerts:
\t\t\t\t-
\t\t\t\t\tCertFile: /mox/private/smtp.crt
\t\t\t\t\tKeyFile: /mox/private/smtp.key
\t\tSubmission:
\t\t\tEnabled: true
\t\t\tPort: 587
Transports:
\tintake:
\t\tSMTP:
\t\t\tHost: mail-intake
\t\t\tPort: 2525
\t\t\tNoSTARTTLS: true
\tcapture:
\t\tSMTP:
\t\t\tHost: mail
\t\t\tPort: 1025
\t\t\tNoSTARTTLS: true
`;
}
const fromAddress = `notifications@${domain}`;
await writeFile(
  `${root}/domains.conf`,
  `Domains:
\t${domain}:
\t\tDKIM:
\t\t\tSign:
\t\t\t\t- oss
\t\t\tSelectors:
\t\t\t\toss:
\t\t\t\t\tPrivateKeyFile: /mox/private/dkim.pem
Accounts:
\tplatform:
\t\tDomain: ${domain}
\t\tDestinations:
\t\t\t${fromAddress}:
\t\t\t\tMailbox: Inbox
Routes:
\t-
\t\tToDomain:
\t\t\t- in.${domain}
\t\tTransport: intake
\t-
\t\tTransport: capture
`,
  { mode: 0o600 },
);
await writeFile(`${root}/mox.conf`, staticConfig("127.0.0.1"), { mode: 0o600 });
for (const path of [`${root}/mox.conf`, `${root}/domains.conf`, `${privateDir}/dkim.pem`])
  await chown(path, 1000, 1000);
execFileSync("mox", ["-config", `${root}/mox.conf`, "config", "test"], {
  stdio: ["ignore", "ignore", "pipe"],
});

const daemon = spawn("mox", ["-config", `${root}/mox.conf`, "serve"], {
  stdio: ["ignore", "ignore", "pipe"],
});
let failed = false;
daemon.once("exit", () => {
  failed = true;
});
const password = randomBytes(32).toString("base64url");
try {
  let ready = false;
  for (let attempt = 0; attempt < 100 && !failed; attempt++) {
    try {
      await access(`${root}/data/ctl`);
      ready = true;
      break;
    } catch {}
    await setTimeout(100);
  }
  if (!ready) throw new Error("Private Mox initialization failed before account setup");
  execFileSync("mox", ["-config", `${root}/mox.conf`, "setaccountpassword", "platform"], {
    input: `${password}\n`,
    stdio: ["pipe", "ignore", "pipe"],
  });
} finally {
  if (daemon.exitCode === null && daemon.signalCode === null) {
    const stopped = new Promise((resolve) => daemon.once("exit", resolve));
    daemon.kill("SIGTERM");
    await stopped;
  }
}
await writeFile(`${root}/mox.conf`, staticConfig("0.0.0.0"), { mode: 0o600 });
await chown(`${root}/mox.conf`, 1000, 1000);
await writeFile(
  metadata,
  JSON.stringify(
    {
      host: "mox",
      port: 587,
      security: "starttls",
      username: fromAddress,
      password,
      fromDomain: domain,
      fromAddress,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
await chown(metadata, 1000, 1000);
await copyFile(`${privateDir}/ca.crt`, `${caDir}/ca.crt`);
await chmod(`${caDir}/ca.crt`, 0o644);
console.info("Private OSS mail configuration initialized; no credentials printed");
