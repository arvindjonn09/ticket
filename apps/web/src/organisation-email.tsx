import { useTranslation } from "react-i18next";
import { InboundMailPanel } from "./inbound-mail";
import { EmailHealthPanel } from "./email-health";
import type { SessionView } from "./types";
import i18n from "./i18n";
import { OutgoingMailPanel } from "./outgoing-mail";

i18n.addResourceBundle("en", "organisationEmail", {
  title: "Email",
  receiving: "1. Receive email as tickets",
  receivingIntro:
    "Copy your organisation's inbound address, configure forwarding at your email provider, then send a forwarding check to your own support mailbox.",
});

export function OrganisationEmail({ session }: { session: SessionView }) {
  const { t } = useTranslation("organisationEmail");
  return (
    <>
      <section className="form-panel" aria-labelledby="organisation-email-receiving">
        <h2 id="organisation-email-receiving">{t("receiving")}</h2>
        <p>{t("receivingIntro")}</p>
      </section>
      <InboundMailPanel session={session} advancedCollapsed />
      <OutgoingMailPanel session={session} />
      <EmailHealthPanel />
    </>
  );
}
