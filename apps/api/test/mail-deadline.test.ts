import { afterEach, expect, it, vi } from "vitest";
import { encryptSecret } from "../src/mfa.js";
import { microsoft365Access } from "../src/microsoft365-mail.js";
import { sendOwnSmtp, closeTenantSmtp, type TenantSmtpSettings } from "../src/tenant-smtp.js";
import type { Tx } from "../src/database.js";

const sdk = vi.hoisted(() => ({
  late: false,
  started: () => {},
  finish: (_value: unknown) => {},
  network: null as null | {
    sendPostRequestAsync: (url: string, options: object) => Promise<{ body: unknown }>;
  },
  send: vi.fn(),
}));
vi.mock("nodemailer", () => ({ createTransport: () => ({ sendMail: sdk.send, close: vi.fn() }) }));
vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    constructor(config: { system: { networkClient: typeof sdk.network } }) {
      sdk.network = config.system.networkClient;
    }
    getTokenCache() {
      return {
        deserialize: vi.fn(),
        serialize: () => "updated-cache",
        getAccountByHomeId: async () => ({ homeAccountId: "fixture" }),
      };
    }
    async acquireTokenSilent() {
      if (sdk.late) {
        sdk.started();
        return new Promise((resolve) => {
          sdk.finish = resolve;
        });
      }
      const response = await sdk.network!.sendPostRequestAsync(
        "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "fixture" },
      );
      return response.body;
    }
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sdk.late = false;
  sdk.send.mockReset();
  closeTenantSmtp("deadline-fixture");
});
function settings() {
  vi.stubEnv("MFA_ENCRYPTION_KEY", "a".repeat(64));
  vi.stubEnv("PLATFORM_MODE", "hosted");
  vi.stubEnv("PUBLIC_SITE_ORIGIN", "https://astrama.test");
  vi.stubEnv("M365_CLIENT_ID", "246b9475-e0fc-4f20-aa9a-af94a5cc83b3");
  vi.stubEnv("M365_CLIENT_SECRET", "fixture-client-credential");
  vi.stubEnv("M365_CLIENT_SECRET_FILE", "");
  vi.stubEnv("M365_REDIRECT_URI", "https://astrama.test/api/mail/microsoft365/callback");
  return {
    tenant_id: "deadline-fixture",
    revision: 1,
    mode: "microsoft365",
    host: "smtp.office365.com",
    port: 587,
    security: "starttls",
    username: "fixture@example.test",
    encrypted_secret: encryptSecret("cached-refresh-fixture", "smtp:deadline-fixture"),
    account_id: "fixture",
  } as TenantSmtpSettings;
}
it("aborts the actual MSAL HTTP request within the shared network deadline", async () => {
  const row = settings();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let observed: AbortSignal | undefined,
    started = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn(
    (_url: string, options: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        observed = options.signal;
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        started();
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  const result = microsoft365Access(row),
    failed = expect(result).rejects.toMatchObject({ kind: "connection" });
  await requestStarted;
  await vi.advanceTimersByTimeAsync(10001);
  await failed;
  expect(observed?.aborted).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("cannot write refreshed credentials or start SMTP after a late token promise resolves", async () => {
  const row = settings();
  sdk.late = true;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const ready = new Promise<void>((resolve) => {
    sdk.started = resolve;
  });
  const execute = vi.fn();
  const tx = { $executeRaw: execute } as unknown as Tx;
  const result = sendOwnSmtp(tx, row, { to: "fixture@example.test", text: "Deadline fixture" });
  const failed = expect(result).rejects.toMatchObject({ kind: "connection" });
  await ready;
  await vi.advanceTimersByTimeAsync(10001);
  await failed;
  sdk.finish({ accessToken: "late-access-fixture" });
  await Promise.resolve();
  await Promise.resolve();
  expect(execute).not.toHaveBeenCalled();
  expect(sdk.send).not.toHaveBeenCalled();
});
