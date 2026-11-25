import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  outgoingSmtpSchema,
  type OutgoingMailView,
  type OutgoingSmtpInput,
} from "@astrama/contracts";
import i18n from "./i18n";

i18n.addResourceBundle("en", "outgoingMail", {
  title: "2. Send email to your users",
  loading: "Loading outgoing email settings…",
  retry: "Refresh outgoing settings",
  modes: {
    platform: "Astrama default",
    smtp: "Other mail server",
    google: "Google Workspace",
    microsoft365: "Microsoft 365",
  },
  mode: "Sending option",
  configuredMode: "Configured sender",
  effectiveMode: "Currently sending through",
  status: "Connection status",
  working: "Working",
  problem: "Problem",
  pending: "Pending",
  ready: "Ready to test",
  unverified: "Unverified changes",
  defaultIntro:
    "Astrama sends notifications using the platform sender. No mailbox credentials are needed.",
  guide:
    "Choose a sender, complete its setup, then send yourself a test. Settings become active only after the test is accepted. Own email is included in every plan.",
  fallback:
    "Astrama default is currently sending your notifications. Review your own connection's status and test it again before switching back.",
  useDefault: "Use Astrama default",
  defaultHint: "This disconnects your own sender and removes its saved credentials.",
  saved: "Test email accepted and sender settings saved.",
  defaultSaved: "Astrama default is now selected.",
  conflict:
    "Another administrator changed these settings. The latest saved sender is shown above; your form entries are retained. Review them, then test again before saving.",
  host: "SMTP host",
  port: "SMTP port",
  security: "Connection security",
  tls: "TLS",
  starttls: "STARTTLS",
  username: "SMTP username",
  password: "SMTP password",
  fromAddress: "From address",
  currentFrom: "Current From address",
  currentHost: "Current SMTP host",
  lastTest: "Last successful test",
  passwordSet: "Password set",
  passwordMissing: "Password not set",
  passwordHint: "Enter the password for each test and save. Saved passwords are never displayed.",
  unverifiedHint:
    "Changes in this form are not active. Your current sender continues until the test succeeds.",
  testSave: "Send test and save",
  testing: "Sending test…",
  invalid: "Review the SMTP fields and select TLS or STARTTLS with a supported port.",
  googleGuide:
    "For Gmail SMTP, use smtp.gmail.com with STARTTLS on port 587, your full Workspace email as username, and an app password. App passwords need 2-Step Verification and may be restricted by your administrator. Alternatively, configure authenticated SMTP relay in Google Workspace, use smtp-relay.gmail.com and require TLS. Follow Google's guide for your account's permitted authentication method.",
  googleDocs: "Google's official SMTP setup guide",
  appPasswords: "Google app password instructions",
  relayDocs: "Google SMTP relay instructions",
  microsoftGuide:
    "Enter the mailbox and From address, then connect to Microsoft 365 and approve consent. After returning here, send a test to finish setup. Reconnect if consent is revoked or the connection needs attention.",
  mailbox: "Microsoft 365 mailbox address",
  connect: "Connect Microsoft 365",
  connecting: "Opening Microsoft sign-in…",
  confirming: "Confirming the Microsoft connection in this signed-in session…",
  handoffInvalid:
    "The Microsoft return link is incomplete or invalid. Connect Microsoft 365 again to start a new setup.",
  handoffDenied:
    "This Microsoft connection could not be confirmed in your current session. Connect Microsoft 365 again from this browser to start a new setup.",
  handoffFailed:
    "The confirmation request failed. Review the refreshed connection status. If it is not ready to test, connect Microsoft 365 again. This request will not be retried automatically.",
  microsoftUnavailable:
    "Microsoft 365 connection is not configured on this installation. Ask your platform operator to enable it, or keep Astrama default.",
  pendingConnection: "Microsoft 365 connection",
  expires: "Connection setup expires {{date}}.",
  microsoftReady: "Microsoft consent received. Send a test before activating this connection.",
  microsoftProblem:
    "Microsoft connection was not completed. Review the connection status and try connecting again.",
  invalidRedirect: "The Microsoft sign-in destination was invalid. Please try connecting again.",
  testCurrent: "Test delivery to my email",
  currentHint:
    "This tests the currently saved sender. Use Send test and save to test changes in the form.",
  accepted: "Test email accepted for sending",
});

export function OutgoingSmtpForm({
  settings,
  provider,
  revision,
  busy,
  disabled = false,
  save,
}: {
  settings: OutgoingMailView["smtp"];
  provider: "google" | "smtp";
  revision: number;
  busy: boolean;
  disabled?: boolean;
  save: (input: OutgoingSmtpInput) => Promise<boolean>;
}) {
  const { t } = useTranslation("outgoingMail");
  const [error, setError] = useState("");
  const existing = settings?.provider === provider ? settings : null;
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const element = event.currentTarget;
        const form = new FormData(element);
        const parsed = outgoingSmtpSchema.safeParse({
          revision,
          provider,
          host: String(form.get("host")).trim(),
          port: Number(form.get("port")),
          security: form.get("security"),
          username: String(form.get("username")).trim(),
          password: String(form.get("password")),
          fromAddress: String(form.get("fromAddress")).trim(),
        });
        setError("");
        if (!parsed.success) {
          setError(t("invalid"));
          return;
        }
        if (await save(parsed.data)) {
          const password = element.elements.namedItem("password") as HTMLInputElement;
          password.value = "";
        }
      }}
    >
      <p>
        {t("unverified")}: {t("unverifiedHint")}
      </p>
      {provider === "google" && (
        <>
          <p>{t("googleGuide")}</p>
          <ul>
            {[
              [
                "googleDocs",
                "https://knowledge.workspace.google.com/admin/gmail/send-email-from-a-printer-scanner-or-app",
              ],
              ["appPasswords", "https://support.google.com/accounts/answer/185833"],
              [
                "relayDocs",
                "https://knowledge.workspace.google.com/admin/gmail/advanced/route-outgoing-smtp-relay-messages-through-google",
              ],
            ].map(([key, url]) => (
              <li key={key}>
                <a
                  className="text-button"
                  style={{ display: "inline-block", minHeight: 24 }}
                  href={url}
                >
                  {t(key!)}
                </a>
              </li>
            ))}
          </ul>
        </>
      )}
      <fieldset disabled={busy || disabled} className="mail-fields">
        <label>
          {t("host")}
          <input
            name="host"
            required
            maxLength={253}
            defaultValue={existing?.host ?? (provider === "google" ? "smtp.gmail.com" : "")}
            autoComplete="off"
          />
        </label>
        <label>
          {t("port")}
          <select name="port" defaultValue={existing?.port ?? 587}>
            {[587, 465, 25, 2525].map((port) => (
              <option key={port} value={port}>
                {port}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("security")}
          <select name="security" defaultValue={existing?.security ?? "starttls"}>
            <option value="starttls">{t("starttls")}</option>
            <option value="tls">{t("tls")}</option>
          </select>
        </label>
        <label>
          {t("username")}
          <input
            name="username"
            required
            maxLength={254}
            defaultValue={existing?.username ?? ""}
            autoComplete="off"
          />
        </label>
        <label>
          {t("password")}
          <input
            name="password"
            type="password"
            required
            maxLength={2000}
            autoComplete="new-password"
          />
          <span className="muted">
            {t(existing?.passwordSet ? "passwordSet" : "passwordMissing")}. {t("passwordHint")}
          </span>
        </label>
        <label>
          {t("fromAddress")}
          <input
            name="fromAddress"
            type="email"
            required
            maxLength={254}
            defaultValue={existing?.fromAddress ?? ""}
          />
        </label>
        <button className="button primary">{t(busy ? "testing" : "testSave")}</button>
      </fieldset>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
