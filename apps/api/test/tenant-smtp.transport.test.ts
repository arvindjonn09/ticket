import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { SMTPServer } from "smtp-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { safeSmtpTransport } from "../src/tenant-smtp.js";

const wire = vi.hoisted(() => ({ port: 0, dials: [] as string[] }));
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));
// Only the test connector maps the vetted public address into a loopback fixture.
// DNS checks, Nodemailer, SMTP, STARTTLS and certificate verification remain real.
vi.mock("node:net", async (original) => {
  const actual = await original<typeof import("node:net")>();
  return {
    ...actual,
    connect(options: import("node:net").TcpNetConnectOpts) {
      if (options.host !== "8.8.8.8") throw new Error("Unexpected fixture target");
      wire.dials.push(options.host);
      return actual.connect({ ...options, host: "127.0.0.1", port: wire.port });
    },
  };
});
vi.mock("node:tls", async (original) => {
  const actual = await original<typeof import("node:tls")>();
  return {
    ...actual,
    connect(options: import("node:tls").ConnectionOptions) {
      if (options.host !== "8.8.8.8") throw new Error("Unexpected fixture target");
      wire.dials.push(options.host);
      return actual.connect({ ...options, host: "127.0.0.1", port: wire.port });
    },
  };
});

describe("tenant SMTP real TLS wire boundary", () => {
  const originalCas = getCACertificates();
  let directory: string, certificate: string, key: string;
  let server: SMTPServer | undefined;
  const authentications: boolean[] = [];
  let deliveries = 0;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "astrama-smtp-wire-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        "1",
        "-subj",
        "/CN=smtp.fixture.test",
        "-addext",
        "subjectAltName=DNS:smtp.fixture.test",
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    certificate = readFileSync(join(directory, "cert.pem"), "utf8");
    key = readFileSync(join(directory, "key.pem"), "utf8");
  });
  beforeEach(() => {
    for (const name of [
      "DATABASE_URL",
      "MIGRATION_DATABASE_URL",
      "S3_ENDPOINT",
      "CLAMAV_HOST",
      "PUBLIC_SITE_ORIGIN",
      "OPERATOR_ORIGIN",
      "APP_ORIGIN",
    ])
      vi.stubEnv(name, "");
    setDefaultCACertificates([...originalCas, certificate]);
    authentications.length = 0;
    wire.dials.length = 0;
    deliveries = 0;
  });
  afterEach(async () => {
    setDefaultCACertificates(originalCas);
    vi.unstubAllEnvs();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });
  afterAll(() => {
    if (directory) {
      expect(basename(directory).startsWith("astrama-smtp-wire-")).toBe(true);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function listen(
    secure: boolean,
    starttls = true,
    delay: { greeting?: number; auth?: number; mail?: number } = {},
  ) {
    server = new SMTPServer({
      secure,
      key,
      cert: certificate,
      logger: false,
      disabledCommands: starttls ? [] : ["STARTTLS"],
      // The plaintext fixture would accept AUTH: the client must refuse first.
      allowInsecureAuth: !starttls,
      onConnect(_session, callback) {
        setTimeout(() => callback(), delay.greeting ?? 0).unref();
      },
      onAuth(auth, session, callback) {
        authentications.push(session.secure);
        setTimeout(() => callback(null, { user: auth.username }), delay.auth ?? 0).unref();
      },
      onMailFrom(_address, _session, callback) {
        setTimeout(() => callback(), delay.mail ?? 0).unref();
      },
      onData(stream, _session, callback) {
        stream.resume();
        stream.on("end", () => {
          deliveries++;
          callback();
        });
      },
    });
    server.on("error", () => {});
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    wire.port = (server.server.address() as { port: number }).port;
  }
  function transport(security: "tls" | "starttls", host = "smtp.fixture.test") {
    return safeSmtpTransport(
      { host, port: security === "tls" ? 465 : 587, security, username: "fixture" },
      "fixture-password",
    );
  }
  const message = {
    from: "support@fixture.test",
    to: "admin@fixture.test",
    subject: "TLS fixture",
    text: "Synthetic transport check",
  };

  it.each(["tls", "starttls"] as const)(
    "sends over real %s with authentication only after TLS",
    async (security) => {
      await listen(security === "tls");
      const mail = transport(security);
      try {
        await mail.sendMail(message);
      } finally {
        mail.close();
      }
      expect(authentications).toEqual([true]);
      expect(deliveries).toBe(1);
      expect(wire.dials).toEqual(["8.8.8.8"]);
    },
  );
  it("refuses a plaintext server before transmitting credentials or mail", async () => {
    await listen(false, false);
    const mail = transport("starttls");
    try {
      await expect(mail.sendMail(message)).rejects.toBeDefined();
    } finally {
      mail.close();
    }
    expect(authentications).toEqual([]);
    expect(deliveries).toBe(0);
  });
  it("bounds the whole SMTP exchange before the tenant transaction expires", async () => {
    // Every individual phase is below its idle timeout, but together they take 16s.
    await listen(false, true, { greeting: 4000, auth: 8000, mail: 4000 });
    const mail = transport("starttls");
    const started = performance.now();
    try {
      await expect(mail.sendMail(message)).rejects.toBeDefined();
    } finally {
      mail.close();
    }
    expect(performance.now() - started).toBeLessThan(13000);
    expect(deliveries).toBe(0);
  }, 15000);
  it.each(["untrusted", "wrong hostname"])(
    "refuses an %s certificate before authentication",
    async (failure) => {
      await listen(true);
      if (failure === "untrusted") setDefaultCACertificates(originalCas);
      const mail = transport(
        "tls",
        failure === "wrong hostname" ? "wrong.fixture.test" : undefined,
      );
      try {
        await expect(mail.sendMail(message)).rejects.toBeDefined();
      } finally {
        mail.close();
      }
      expect(authentications).toEqual([]);
      expect(deliveries).toBe(0);
    },
  );
});
