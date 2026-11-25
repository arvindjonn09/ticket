import { useTranslation } from "react-i18next";
import { InboundMailPanel } from "./inbound-mail";
import { EmailHealthPanel } from "./email-health";
import type { SessionView } from "./types";
import i18n from "./i18n";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

i18n.addResourceBundle("en", "organisationEmail", {
  title: "Email",
  receiving: "1. Receive email as tickets",
  receivingIntro:
    "Copy your organisation's inbound address, configure forwarding at your email provider, then send a forwarding check to your own support mailbox.",
  sending: "2. Send email to your users",
  defaultMode: "Astrama default",
  working: "Working",
  pending: "Pending",
  problem: "Problem",
  sendingIntro:
    "Astrama sends notifications for your organisation using the platform's configured sender. No mailbox credentials are needed.",
  sendingGuide:
    "1. Create or reply to a ticket. 2. Check the recipient's inbox. 3. Review delivery attempts below if the notification does not arrive.",
  test: "Test delivery to my email",
  testing: "Sending test…",
  testAccepted: "Test email accepted for sending",
});

export function OrganisationEmail({ session }: { session: SessionView }) {
  const { t } = useTranslation("organisationEmail");
  const cache = useQueryClient();
  const test = useMutation({
    mutationFn: () =>
      api<{ sent: true }>(
        "/admin/operations/email/test",
        { method: "POST", body: "{}" },
        session.csrfToken,
      ),
    onSuccess: () => void cache.invalidateQueries({ queryKey: ["email-health"] }),
  });
  return (
    <>
      <section className="form-panel" aria-labelledby="organisation-email-receiving">
        <h2 id="organisation-email-receiving">{t("receiving")}</h2>
        <p>{t("receivingIntro")}</p>
      </section>
      <InboundMailPanel session={session} advancedCollapsed />
      <section className="form-panel" aria-labelledby="organisation-email-sending">
        <h2 id="organisation-email-sending">{t("sending")}</h2>
        <h3>{t("defaultMode")}</h3>
        <p role="status">{t(test.isPending ? "pending" : test.error ? "problem" : "working")}</p>
        <p>{t("sendingIntro")}</p>
        <p>{t("sendingGuide")}</p>
        <button
          className="button secondary"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          {t(test.isPending ? "testing" : "test")}
        </button>
        {test.isSuccess && <p role="status">{t("testAccepted")}</p>}
        {test.error && (
          <p role="alert" className="error">
            {test.error.message}
          </p>
        )}
      </section>
      <EmailHealthPanel />
    </>
  );
}
