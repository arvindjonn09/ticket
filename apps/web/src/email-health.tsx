import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { EmailHealthView } from "@astrama/contracts";
import i18n from "./i18n";
import { api } from "./api";

i18n.addResourceBundle("en", "emailHealth", {
  title: "Email health",
  description: "Delivery attempts for your organisation in the last 24 hours.",
  sent: "Sent",
  failed: "Failed attempts",
  queued: "Waiting to send",
  allowance: "This hour's sending allowance",
  usage: "{{used}} of {{limit}} attempts",
  unconfigured: "No hosted sending allowance configured",
  loading: "Loading email health…",
  refresh: "Refresh email health",
});

export function EmailHealthPanel() {
  const { t } = useTranslation("emailHealth");
  const query = useQuery({
    queryKey: ["email-health"],
    queryFn: () => api<EmailHealthView>("/admin/operations/email"),
    staleTime: 30_000,
  });
  return (
    <section className="form-panel" aria-label={t("title")}>
      <h2>{t("title")}</h2>
      <p className="muted">{t("description")}</p>
      {query.isPending && <p role="status">{t("loading")}</p>}
      {query.error && (
        <p className="error" role="alert">
          {query.error.message}
        </p>
      )}
      {query.data && (
        <dl>
          {(["sent", "failed", "queued"] as const).map((key) => (
            <div key={key}>
              <dt>{t(key)}</dt>
              <dd>{query.data[key]}</dd>
            </div>
          ))}
          <div>
            <dt>{t("allowance")}</dt>
            <dd>
              {query.data.outboundLimit === null
                ? t("unconfigured")
                : t("usage", { used: query.data.outboundUsed, limit: query.data.outboundLimit })}
            </dd>
          </div>
        </dl>
      )}
      <button
        className="button secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        {t("refresh")}
      </button>
    </section>
  );
}
