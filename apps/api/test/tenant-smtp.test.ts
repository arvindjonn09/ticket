import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { lookup } from "node:dns/promises";
import { publicSmtpIp, resolveSmtpTarget, safeSmtpTransport } from "../src/tenant-smtp.js";

const sockets = vi.hoisted(() => ({
  opened: [] as { kind: string; options: Record<string, unknown> }[],
}));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
}));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    connect: (options: Record<string, unknown>) => {
      sockets.opened.push({ kind: "tcp", options });
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      socket.setTimeout = vi.fn();
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
  };
});
vi.mock("node:tls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:tls")>();
  return {
    ...actual,
    connect: (options: Record<string, unknown>) => {
      sockets.opened.push({ kind: "tls", options });
      const socket = new EventEmitter() as EventEmitter & {
        setTimeout: ReturnType<typeof vi.fn>;
        destroy: ReturnType<typeof vi.fn>;
      };
      socket.setTimeout = vi.fn();
      socket.destroy = vi.fn();
      queueMicrotask(() => socket.emit("secureConnect"));
      return socket;
    },
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  sockets.opened.length = 0;
});
function environment() {
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
}
describe("tenant SMTP connection boundary", () => {
  it("does not let an old timed-out DNS lookup dial after the cached transport is reused", async () => {
    environment();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finishDns: (value: unknown) => void = () => {};
    vi.mocked(lookup).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishDns = resolve;
        }) as never,
    );
    const mail = safeSmtpTransport(
      { host: "smtp.example.com", port: 587, security: "starttls", username: "fixture" },
      "fixture",
    );
    const getSocket = (
      mail.options as {
        getSocket: (
          options: object,
          callback: (error: Error | null, value?: { connection: EventEmitter }) => void,
        ) => void;
      }
    ).getSocket;
    const connect = () =>
      new Promise<{ connection: EventEmitter }>((resolve, reject) =>
        getSocket({}, (error, value) => (error ? reject(error) : resolve(value!))),
      );
    const first = connect();
    const failed = expect(first).rejects.toMatchObject({ kind: "connection" });
    await vi.advanceTimersByTimeAsync(5001);
    await failed;
    const next = await connect();
    expect(sockets.opened).toHaveLength(1);
    finishDns([{ address: "1.1.1.1", family: 4 }]);
    await Promise.resolve();
    await Promise.resolve();
    expect(sockets.opened).toHaveLength(1);
    next.connection.emit("close");
    mail.close();
  });
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
  ])("refuses nonpublic address %s", async (ip) => {
    environment();
    expect(publicSmtpIp(ip)).toBe(false);
    await expect(resolveSmtpTarget(ip)).rejects.toThrow();
  });
  it.each(["db", "storage", "scanner", "mailpit", "mox", "localhost", "host.docker.internal"])(
    "refuses service target %s",
    async (host) => {
      environment();
      if (host.includes("."))
        vi.mocked(lookup).mockResolvedValue([{ address: "192.168.65.254", family: 4 }] as never);
      await expect(resolveSmtpTarget(host)).rejects.toThrow();
    },
  );
  it("refuses hostnames with any private answer, aliases of a configured public service, and DNS failure", async () => {
    environment();
    vi.mocked(lookup).mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ] as never);
    await expect(resolveSmtpTarget("mail.example.com")).rejects.toThrow();
    vi.stubEnv("S3_ENDPOINT", "https://storage.example.com");
    vi.mocked(lookup).mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
    await expect(resolveSmtpTarget("alias.example.com")).rejects.toThrow();
    vi.stubEnv("S3_ENDPOINT", "");
    vi.mocked(lookup).mockRejectedValue(
      Object.assign(new Error("DNS private diagnostic"), { code: "EAI_AGAIN" }),
    );
    await expect(resolveSmtpTarget("mail.example.com")).rejects.toMatchObject({
      kind: "connection",
      message: "Outgoing mail failed",
    });
  });
  it("pins each new connection to a newly vetted IP and preserves TLS verification/SNI", async () => {
    environment();
    vi.stubEnv("PUBLIC_SITE_ORIGIN", "https://astrama.localhost");
    const mail = safeSmtpTransport(
      { host: "smtp.example.com", port: 465, security: "tls", username: "fixture" },
      "fixture",
    );
    const options = mail.options as {
      tls: unknown;
      getSocket: (
        options: object,
        callback: (error: Error | null, value?: unknown) => void,
      ) => void;
    };
    expect(options.tls).toMatchObject({
      servername: "smtp.example.com",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    const connect = () =>
      new Promise((resolve, reject) =>
        options.getSocket({}, (error, value) => (error ? reject(error) : resolve(value))),
      );
    await connect();
    expect(sockets.opened.at(-1)).toMatchObject({
      kind: "tls",
      options: { host: "8.8.8.8", servername: "smtp.example.com", rejectUnauthorized: true },
    });
    vi.mocked(lookup).mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    await connect();
    expect(sockets.opened.at(-1)!.options.host).toBe("1.1.1.1");
    vi.mocked(lookup).mockResolvedValue([{ address: "127.0.0.1", family: 4 }] as never);
    await expect(connect()).rejects.toMatchObject({ kind: "address" });
    expect(sockets.opened).toHaveLength(2);
    mail.close();
    expect(publicSmtpIp("2606:4700:4700::1111")).toBe(true);
  });
  it("requires STARTTLS before SMTP authentication and never connects an unchecked hostname", async () => {
    environment();
    const mail = safeSmtpTransport(
      { host: "smtp.example.com", port: 587, security: "starttls", username: "fixture" },
      "fixture",
    );
    expect(mail.options).toMatchObject({
      secure: false,
      requireTLS: true,
      tls: { rejectUnauthorized: true, servername: "smtp.example.com" },
    });
    const options = mail.options as {
      getSocket: (
        options: object,
        callback: (error: Error | null, value?: unknown) => void,
      ) => void;
    };
    await new Promise((resolve, reject) =>
      options.getSocket({}, (error, value) => (error ? reject(error) : resolve(value))),
    );
    expect(sockets.opened.at(-1)).toMatchObject({
      kind: "tcp",
      options: { host: "8.8.8.8", port: 587 },
    });
    mail.close();
  });
});
