import { readFileSync } from "node:fs";
import { ConfidentialClientApplication } from "@azure/msal-node";
import type { Tx } from "./database.js";
import { decryptSecret, encryptSecret } from "./mfa.js";
import { OutgoingMailError, currentMailDeadline, withMailDeadline } from "./mail-deadline.js";
export { OutgoingMailError } from "./mail-deadline.js";
export const smtpScopes = ["https://outlook.office.com/SMTP.Send", "offline_access"];
export function microsoft365Config() {
  try {
    const clientId = process.env.M365_CLIENT_ID;
    if (
      !clientId ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(clientId) ||
      (process.env.M365_CLIENT_SECRET && process.env.M365_CLIENT_SECRET_FILE)
    )
      return null;
    const secret = process.env.M365_CLIENT_SECRET_FILE
      ? readFileSync(process.env.M365_CLIENT_SECRET_FILE, "utf8").trim()
      : process.env.M365_CLIENT_SECRET;
    const redirectUri = process.env.M365_REDIRECT_URI;
    if (!secret || !redirectUri) return null;
    const uri = new URL(redirectUri);
    const expected =
      process.env.PLATFORM_MODE === "hosted"
        ? process.env.PUBLIC_SITE_ORIGIN
        : process.env.APP_ORIGIN;
    if (
      uri.protocol !== "https:" ||
      uri.origin !== expected ||
      uri.pathname !== "/api/mail/microsoft365/callback" ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password
    )
      return null;
    return { clientId, clientSecret: secret, redirectUri };
  } catch {
    return null;
  }
}
export function microsoft365Client() {
  const config = microsoft365Config();
  if (!config) throw new OutgoingMailError("oauth_unavailable");
  return {
    redirectUri: config.redirectUri,
    client: new ConfidentialClientApplication({
      auth: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        authority: "https://login.microsoftonline.com/organizations",
      },
      system: {
        loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        networkClient: {
          sendGetRequestAsync: <T>(url: string, options?: { headers?: Record<string, string> }) =>
            microsoftNetwork<T>("GET", url, options),
          sendPostRequestAsync: <T>(
            url: string,
            options?: { headers?: Record<string, string>; body?: string },
          ) => microsoftNetwork<T>("POST", url, options),
        },
      },
    }),
  };
}
export async function microsoft365Access(settings: {
  tenant_id: string;
  encrypted_secret: string | null;
  account_id: string | null;
}) {
  return withMailDeadline(undefined, async (deadline) => {
    const { client } = microsoft365Client();
    if (!settings.encrypted_secret || !settings.account_id) throw new OutgoingMailError("consent");
    const cache = client.getTokenCache();
    try {
      cache.deserialize(decryptSecret(settings.encrypted_secret, `smtp:${settings.tenant_id}`));
    } catch {
      throw new OutgoingMailError("consent");
    }
    const account = await deadline.run(() => cache.getAccountByHomeId(settings.account_id!));
    if (!account) throw new OutgoingMailError("consent");
    try {
      const token = await deadline.run(() =>
        client.acquireTokenSilent({ account, scopes: smtpScopes }),
      );
      deadline.check();
      if (!token?.accessToken) throw new OutgoingMailError("consent");
      return {
        accessToken: token.accessToken,
        encryptedCache: encryptSecret(cache.serialize(), `smtp:${settings.tenant_id}`),
      };
    } catch (error) {
      if (error instanceof OutgoingMailError) throw error;
      const code = (error as { errorCode?: string }).errorCode;
      throw new OutgoingMailError(
        code &&
          ["invalid_grant", "interaction_required", "consent_required", "no_tokens_found"].includes(
            code,
          )
          ? "consent"
          : "connection",
      );
    }
  });
}
export async function microsoft365Token(
  tx: Tx,
  settings: { tenant_id: string; encrypted_secret: string | null; account_id: string | null },
) {
  const token = await microsoft365Access(settings);
  currentMailDeadline()?.check();
  await tx.$executeRaw`UPDATE tenant_outgoing_mail SET encrypted_secret=${token.encryptedCache} WHERE tenant_id=${settings.tenant_id}::uuid`;
  return token.accessToken;
}

async function microsoftNetwork<T>(
  method: "GET" | "POST",
  url: string,
  options?: { headers?: Record<string, string>; body?: string },
) {
  return withMailDeadline(undefined, async (deadline) =>
    deadline.run(async () => {
      // MSAL's own POST HTTP client has no public timeout option. Abort its actual request.
      const response = await fetch(url, {
        method,
        headers: options?.headers,
        ...(method === "POST" ? { body: options?.body } : {}),
        signal: deadline.signal,
        redirect: "error",
      });
      const body = (await response.json()) as T;
      deadline.check();
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    }),
  );
}

export function outgoingError(error: unknown) {
  if (error instanceof OutgoingMailError) return error;
  const code =
    error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
  return new OutgoingMailError(
    code === "EAUTH"
      ? "authentication"
      : code === "ETLS" ||
          (code === "ESOCKET" && /certificate|TLS/i.test(String((error as Error).message)))
        ? "tls"
        : ["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(code ?? "")
          ? "connection"
          : "delivery",
  );
}
export function outgoingErrorText(code: string | null) {
  if (!code) return null;
  return (
    (
      {
        authentication: "SMTP authentication failed. Check the username and password.",
        connection: "Could not connect to the mail server. Check the host and port.",
        tls: "A trusted TLS connection is required. Check the server certificate and security setting.",
        address: "This SMTP address is unavailable. Use a public mail server.",
        delivery:
          "The mail server rejected the message. Check the sending address and mailbox permissions.",
        consent: "Microsoft 365 access was revoked or expired. Connect Microsoft 365 again.",
        oauth_unavailable: "Microsoft 365 connection is not configured by the platform operator.",
      } as Record<string, string>
    )[code] ?? "Outgoing email failed. Check your connection settings."
  );
}
