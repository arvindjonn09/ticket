import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { InboundMailView } from "@astrama/contracts";
import { api } from "./api";
import { displayDate } from "./dates";
import i18n from "./i18n";

i18n.addResourceBundle("en", "forwardingGuide", {
  title: "Forward your support email",
  intro: "Forward messages from your own support mailbox to this platform address.",
  address: "Platform inbound address",
  unavailable: "An inbound address is not configured. Contact your platform operator.",
  copy: "Copy address",
  copied: "Address copied.",
  copyFailed: "Could not copy the address. Select and copy it from the field above.",
  microsoft: "Microsoft 365",
  microsoftGuide:
    "In the Exchange admin centre, create a mail flow rule or enable mailbox forwarding from your support mailbox to the platform address. Your outbound spam policy must allow automatic external forwarding for this mailbox. Keep a copy in the original mailbox if needed.",
  google: "Google Workspace",
  googleGuide:
    "In the Google Admin console, open Apps → Google Workspace → Gmail → Routing. Add a routing rule for messages addressed to your support mailbox and deliver them to the platform address. Keep delivery to the original mailbox if needed.",
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
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(platformAddress);
                setCopyResult(t("copied"));
              } catch {
                setCopyResult(t("copyFailed"));
              }
            }}
          >
            {t("copy")}
          </button>
          {copyResult && <p role="status">{copyResult}</p>}
          {(["microsoft", "google", "other"] as const).map((provider) => (
            <details key={provider}>
              <summary style={{ minHeight: 24 }}>{t(provider)}</summary>
              <p>{t(`${provider}Guide`)}</p>
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
              <li key={address.id}>{address.address}</li>
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
