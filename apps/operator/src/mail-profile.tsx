import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  platformMailProfileSchema,
  type PlatformMailProfileInput,
  type PlatformMailDnsView,
} from "@astrama/contracts";
import i18n from "./i18n";

i18n.addResourceBundle("en-AU", "platformEmail", {
  title: "Platform email",
  sending: "Sending",
  receiving: "Receiving",
  loading: "Loading email settings…",
  refresh: "Refresh email settings",
  intro:
    "1. Create a profile. 2. Check DNS and send yourself a test. 3. Activate with your authenticator code. Keep the previous profile for rollback.",
  create: "Create sending profile",
  saved: "Draft profile saved. Send a test before activation.",
  immutable:
    "Profiles are saved as new drafts. To change credentials or settings, create a new profile.",
  provider: "Provider preset",
  providers: {
    mox: "Self-hosted (mox)",
    ses: "Amazon SES",
    postmark: "Postmark",
    mailgun: "Mailgun",
    smtp: "Other SMTP",
  },
  name: "Profile name (optional)",
  host: "SMTP host",
  port: "SMTP port",
  security: "Connection security",
  tls: "TLS",
  starttls: "STARTTLS",
  invalidProfile:
    "Review the SMTP settings. Use a supported port (25, 465, 587 or 2525), and ensure the From address belongs to the From domain.",
  username: "SMTP username",
  password: "SMTP password",
  passwordHint: "Write-only. A saved password is never displayed.",
  fromDomain: "From domain",
  fromAddress: "From address",
  region: "AWS region",
  regionHint:
    "Choose the region where your SES sending identity is verified. Presets remain editable.",
  moxHint:
    "Use the mox host, credentials and From domain from your private mail setup file. The application must trust its TLS certificate.",
  advanced: "Advanced DNS values",
  dkimSelector: "DKIM selector",
  dkimRecord: "DKIM TXT value",
  spfRecord: "SPF TXT value",
  save: "Save new draft",
  profiles: "Sending profiles",
  selectProfile: "Select a profile",
  noProfiles: "No saved profiles. Environment settings remain the bootstrap fallback.",
  active: "Active",
  draft: "Draft",
  tested: "Test passed",
  untested: "Test required",
  passwordSet: "Password set",
  previous: "Previous profile",
  test: "Send test email to me",
  testPassed: "Test email sent to your operator address. Check your inbox before activating.",
  activate: "Activate profile",
  rollback: "Roll back",
  activated: "Active sending profile updated.",
  confirm: "Confirm sending change",
  reason: "Reason for this change",
  totp: "Fresh six-digit authenticator code",
  cancel: "Cancel",
  submit: "Confirm change",
  busy: "Working…",
  conflict:
    "Settings changed in another session. The latest settings have been loaded. Review them and enter a fresh authenticator code before retrying.",
  dns: "DNS checklist",
  dnsHint:
    "Copy the expected records to your DNS provider, then check again. Provider-specific SPF and DKIM values come from your mail provider.",
  checkDns: "Check DNS",
  recordType: "Type",
  recordName: "Name",
  expected: "Expected value",
  actual: "Observed values",
  status: "Status",
  pass: "✓ Pass",
  problem: "✗ Needs attention",
  unchecked: "Not checked",
  copy: "Copy value",
  copied: "Value copied.",
  copyFailed: "Could not copy. Select and copy the displayed value.",
  health: "Sending in the last 24 hours",
  sent: "Sent",
  failed: "Failures",
  bounceRate: "Reported bounce rate",
  unknown: "Not reported",
  junkRisk:
    "Bounce rate exceeds 5%. Review delivery failures and sender reputation before sending more mail.",
  receivingIntro:
    "1. Point your inbound domain's MX record to the intake service. 2. Check DNS. 3. Send a test to a known organisation intake alias.",
  domain: "Inbound domain",
  mx: "MX record",
  lastReceived: "Last message received",
  queueDepth: "Queue depth",
  rejected: "Rejected messages",
  intakeAddress: "Known organisation intake address",
  testIntake: "Send test to intake",
  intakePending: "Intake test queued. Refresh to check whether it arrived.",
  testStatus: "Intake test status",
  pending: "Pending",
  working: "Working",
  not_set_up: "Not set up",
  problemStatus: "Problem",
});

const presets = {
  mox: { host: "mox", port: 587, security: "starttls" },
  ses: { host: "", port: 587, security: "starttls" },
  postmark: { host: "smtp.postmarkapp.com", port: 587, security: "starttls" },
  mailgun: { host: "smtp.mailgun.org", port: 587, security: "starttls" },
  smtp: { host: "", port: 587, security: "starttls" },
} as const;

export function MailProfileForm({
  save,
  busy,
}: {
  save: (profile: PlatformMailProfileInput) => Promise<boolean>;
  busy: boolean;
}) {
  const { t } = useTranslation("platformEmail");
  const [provider, setProvider] = useState<keyof typeof presets>("mox");
  const [presetRevision, setPresetRevision] = useState(0);
  const [error, setError] = useState("");
  const [host, setHost] = useState<string>(presets.mox.host);
  return (
    <section className="card" aria-labelledby="create-mail-profile">
      <h2 id="create-mail-profile">{t("create")}</h2>
      <p>{t("immutable")}</p>
      <fieldset>
        <legend>{t("provider")}</legend>
        <div className="toolbar">
          {(Object.keys(presets) as (keyof typeof presets)[]).map((value) => (
            <button
              type="button"
              key={value}
              aria-pressed={provider === value}
              onClick={() => {
                setProvider(value);
                setPresetRevision((revision) => revision + 1);
                setHost(presets[value].host);
                setError("");
              }}
            >
              {t(`providers.${value}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <form
        key={`${provider}-${presetRevision}`}
        onSubmit={async (event) => {
          event.preventDefault();
          const element = event.currentTarget;
          const form = new FormData(element);
          const parsed = platformMailProfileSchema.safeParse({
            provider,
            name: String(form.get("name") ?? "").trim() || String(form.get("fromAddress")).trim(),
            host: host.trim(),
            port: Number(form.get("port")),
            security: form.get("security"),
            username: String(form.get("username")),
            password: String(form.get("password")),
            fromDomain: String(form.get("fromDomain")).trim(),
            fromAddress: String(form.get("fromAddress")).trim(),
            ...Object.fromEntries(
              ["dkimSelector", "dkimRecord", "spfRecord"].map((key) => [
                key,
                String(form.get(key) ?? "").trim() || undefined,
              ]),
            ),
          });
          setError("");
          if (!parsed.success) {
            setError(t("invalidProfile"));
            return;
          }
          if (await save(parsed.data)) {
            element.reset();
            setHost(presets[provider].host);
          }
        }}
      >
        {provider === "ses" && (
          <label>
            {t("region")}
            <input
              name="region"
              required
              pattern="[a-z0-9-]+"
              onChange={(event) =>
                setHost(event.target.value ? `email-smtp.${event.target.value}.amazonaws.com` : "")
              }
            />
            <span className="muted">{t("regionHint")}</span>
          </label>
        )}
        {provider === "mox" && <p>{t("moxHint")}</p>}
        <div className="fields">
          <label>
            {t("name")}
            <input name="name" maxLength={120} />
          </label>
          <label>
            {t("host")}
            <input
              name="host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              required
              maxLength={253}
              autoComplete="off"
            />
          </label>
          <label>
            {t("port")}
            <input
              name="port"
              type="number"
              min={1}
              max={65535}
              defaultValue={presets[provider].port}
              required
            />
          </label>
          <label>
            {t("security")}
            <select name="security" defaultValue={presets[provider].security}>
              <option value="starttls">{t("starttls")}</option>
              <option value="tls">{t("tls")}</option>
            </select>
          </label>
          <label>
            {t("username")}
            <input name="username" required autoComplete="off" maxLength={254} />
          </label>
          <label>
            {t("password")}
            <input
              name="password"
              type="password"
              required
              autoComplete="new-password"
              maxLength={2000}
            />
            <span className="muted">{t("passwordHint")}</span>
          </label>
          <label>
            {t("fromDomain")}
            <input name="fromDomain" required maxLength={253} />
          </label>
          <label>
            {t("fromAddress")}
            <input name="fromAddress" type="email" required maxLength={254} />
          </label>
        </div>
        <details>
          <summary>{t("advanced")}</summary>
          {["dkimSelector", "dkimRecord", "spfRecord"].map((key) => (
            <label key={key}>
              {t(key)}
              <input name={key} maxLength={4096} />
            </label>
          ))}
        </details>
        <button disabled={busy}>{t(busy ? "busy" : "save")}</button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </section>
  );
}

export function MailDnsRecords({ records }: { records: PlatformMailDnsView["records"] }) {
  const { t } = useTranslation("platformEmail");
  const [notice, setNotice] = useState("");
  return (
    <>
      <div className="table-wrap">
        <table>
          <caption>{t("dns")}</caption>
          <thead>
            <tr>
              {["recordType", "recordName", "expected", "actual", "status"].map((key) => (
                <th scope="col" key={key}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={`${record.name}-${record.type}-${index}`}>
                <td>{record.type}</td>
                <td className="preserve">{record.name}</td>
                <td>
                  <code className="preserve">{record.expected}</code>
                  {record.expected && (
                    <button
                      type="button"
                      aria-label={`${t("copy")}: ${record.name}`}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(record.expected);
                          setNotice(t("copied"));
                        } catch {
                          setNotice(t("copyFailed"));
                        }
                      }}
                    >
                      {t("copy")}
                    </button>
                  )}
                </td>
                <td className="preserve">{record.actual.join("\n") || t("unknown")}</td>
                <td>{t(record.ok ? "pass" : "problem")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
