import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InboundMailView } from "@astrama/contracts";
import { api } from "./api";
import { displayDate } from "./dates";
import i18n from "./i18n";

i18n.addResourceBundle("en", "forwardingGuide", {
  title: "Forward your support email",
  advanced: "Advanced receiving configuration",
  intro: "Forward messages from your own support mailbox to this platform address.",
  address: "Platform inbound address",
  unavailable: "An inbound address is not configured. Contact your platform operator.",
  copy: "Copy address",
  copied: "Address copied.",
  copyFailed: "Could not copy the address. Select and copy it from the field above.",
  officialGuide: "Open the official provider guide",
  externalPolicy: "Allow external forwarding in Microsoft 365",
  example: "Example Astrama setup — use your own organisation's address and current test subject.",
  addressExample: "Example Astrama inbound address field and copy button",
  testExample: "Example Astrama pending forwarding check and test subject",
  microsoft: "Microsoft 365",
  microsoftGuide:
    "In the Exchange admin centre, open Recipients → Mailboxes, select your support mailbox, then Mailbox → Email forwarding → Manage email forwarding. Enter the platform address as the external destination. A mail flow rule is another option. Your outbound spam policy must allow automatic external forwarding for this mailbox. Keep a copy in the original mailbox if needed.",
  google: "Google Workspace",
  googleGuide:
    "In the Google Admin console, open Apps → Google Workspace → Gmail → Routing at the top organisation. Configure Email forwarding using recipient address map. Name the rule and add your support mailbox as Address and the platform address as Map to address. Apply it to all incoming messages, optionally also deliver to the original destination, then save. Preserve the original sender. Changes can take up to 24 hours.",
  other: "Other mail providers",
  otherGuide:
    "In your mail provider's settings, forward incoming messages from your support mailbox to the platform address. Allow external forwarding and preserve the original message and sender.",
  aliases: "Configured department addresses",
  check: "Check now",
  checking: "Preparing check…",
  checkHint:
    "Send a new email to your own support mailbox with the exact subject below. Your forwarding rule must deliver it to the platform address. Sending directly to the platform address does not test your forwarding rule.",
  subject: "Test email subject",
  expires: "This check expires {{date}}.",
  lastReceived: "Last email received: {{date}}",
  statuses: {
    not_set_up: "Not set up",
    pending: "Pending",
    working: "Working",
    problem: "Problem",
  },
  problemHint:
    "The forwarding check did not arrive in time. Review your forwarding settings and try again.",
});

export function ForwardingGuide({
  config,
  csrfToken,
}: {
  config: InboundMailView;
  csrfToken: string;
}) {
  const { t } = useTranslation("forwardingGuide");
  const cache = useQueryClient();
  const [copyResult, setCopyResult] = useState("");
  const check = useMutation({
    mutationFn: () =>
      api<{ testCode: string; expiresAt: string }>(
        "/admin/inbound-mail/check",
        { method: "POST", body: "{}" },
        csrfToken,
      ),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["inbound-mail"] }),
  });
  const status = config.forwarding?.status ?? "not_set_up";
  const platformAddress = config.platformAddress;
  const aliases = config.addresses.filter((address) => address.active);
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      setCopyResult(t("copied"));
    } catch {
      setCopyResult(t("copyFailed"));
    }
  }
  return (
    <section className="form-panel" aria-labelledby="forwarding-guide-title">
      <h2 id="forwarding-guide-title">{t("title")}</h2>
      <p>{t("intro")}</p>
      <p role="status">{t(`statuses.${status}`)}</p>
      {status === "problem" && <p>{t("problemHint")}</p>}
      {platformAddress ? (
        <>
          <label>
            {t("address")}
            <input
              readOnly
              value={platformAddress}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <button
            type="button"
            className="button secondary"
            onClick={() => void copyAddress(platformAddress)}
          >
            {t("copy")}
          </button>
          {copyResult && <p role="status">{copyResult}</p>}
          {(["microsoft", "google", "other"] as const).map((provider) => (
            <details key={provider}>
              <summary style={{ minHeight: 24 }}>{t(provider)}</summary>
              <p>{t(`${provider}Guide`)}</p>
              {provider !== "other" && (
                <p>
                  <a
                    className="text-button"
                    style={{ display: "inline-block", minHeight: 24 }}
                    href={
                      provider === "microsoft"
                        ? "https://learn.microsoft.com/en-us/microsoft-365/admin/email/configure-email-forwarding?view=o365-worldwide"
                        : "https://knowledge.workspace.google.com/admin/gmail/advanced/redirect-or-forward-gmail-messages-to-another-user"
                    }
                  >
                    {t("officialGuide")}
                  </a>
                </p>
              )}
              {provider === "microsoft" && (
                <p>
                  <a
                    className="text-button"
                    style={{ display: "inline-block", minHeight: 24 }}
                    href="https://learn.microsoft.com/en-us/defender-office-365/outbound-spam-policies-external-email-forwarding"
                  >
                    {t("externalPolicy")}
                  </a>
                </p>
              )}
              {(["address", "test"] as const).map((step) => (
                <figure key={step}>
                  <img
                    src={`/guides/forwarding-${step}.png`}
                    alt={t(`${step}Example`)}
                    loading="lazy"
                    style={{ width: "100%", maxWidth: 680, height: "auto" }}
                  />
                  <figcaption className="muted">{t("example")}</figcaption>
                </figure>
              ))}
            </details>
          ))}
        </>
      ) : (
        <p>{t("unavailable")}</p>
      )}
      {aliases.length > 0 && (
        <>
          <h3>{t("aliases")}</h3>
          <ul>
            {aliases.map((address) => (
              <li key={address.id}>
                {address.address}{" "}
                <button
                  type="button"
                  className="button secondary"
                  aria-label={`${t("copy")}: ${address.address}`}
                  onClick={() => void copyAddress(address.address)}
                >
                  {t("copy")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button
        type="button"
        className="button primary"
        disabled={!config.configured || !config.platformAddress || check.isPending}
        onClick={() => check.mutate()}
      >
        {t(check.isPending ? "checking" : "check")}
      </button>
      {check.error && (
        <p role="alert" className="error">
          {check.error.message}
        </p>
      )}
      {check.data && (
        <div role="status">
          <p>{t("checkHint")}</p>
          <label>
            {t("subject")}
            <input
              readOnly
              value={`Astrama forwarding check ${check.data.testCode}`}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          <p>{t("expires", { date: displayDate(check.data.expiresAt) })}</p>
        </div>
      )}
      {config.forwarding?.lastReceivedAt && (
        <p>{t("lastReceived", { date: displayDate(config.forwarding.lastReceivedAt) })}</p>
      )}
    </section>
  );
}
