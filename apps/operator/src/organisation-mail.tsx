import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OutgoingMailSummary } from "@astrama/contracts";
import { ApiError, type Call, type Failure } from "./api";
import i18n from "./i18n";

i18n.addResourceBundle("en-AU", "organisationMail", {
  title: "Organisation outgoing email",
  mode: "Configured sender",
  effectiveMode: "Currently sending through",
  status: "Connection status",
  working: "Working",
  problem: "Problem",
  modes: { platform: "Astrama default", smtp: "Own SMTP server", microsoft365: "Microsoft 365" },
  loading: "Loading mail status…",
  refresh: "Refresh mail status",
  reset: "Reset to Astrama default",
  reason: "Reason for resetting email",
  resetHint:
    "Resetting disconnects the organisation's own sender and removes its saved credentials. Mail uses Astrama default afterwards.",
  resetDone: "Organisation sender reset to Astrama default.",
  busy: "Resetting…",
  conflict: "Mail settings changed. Review the refreshed status and try again.",
});

export function OrganisationMail({
  id,
  owner,
  call,
  fail,
}: {
  id: string;
  owner: boolean;
  call: Call;
  fail: Failure;
}) {
  const { t } = useTranslation("organisationMail");
  const [view, setView] = useState<OutgoingMailSummary | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const load = useCallback(
    async () => setView(await call<OutgoingMailSummary>(`/organisations/${id}/outgoing-email`)),
    [call, id],
  );
  const report = useCallback(
    (error: unknown) => {
      setError(error instanceof Error ? error.message : String(error));
      if (error instanceof ApiError && error.status === 401) fail(error);
    },
    [fail],
  );
  useEffect(() => {
    void load().catch(report);
  }, [load, report]);
  return (
    <section className="card" aria-labelledby="organisation-mail-title">
      <h2 id="organisation-mail-title">{t("title")}</h2>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setError("");
          void load().catch(report);
        }}
      >
        {t("refresh")}
      </button>
      {!view ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          <dl>
            {[
              ["mode", t(`modes.${view.mode}`)],
              ["effectiveMode", t(`modes.${view.effectiveMode}`)],
              ["status", t(view.status)],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{t(key!)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {owner && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const element = event.currentTarget;
                const reason = String(new FormData(element).get("reason")).trim();
                setBusy(true);
                setError("");
                setNotice("");
                try {
                  setView(
                    await call<OutgoingMailSummary>(`/organisations/${id}/outgoing-email/reset`, {
                      revision: view.revision,
                      reason,
                    }),
                  );
                  element.reset();
                  setNotice(t("resetDone"));
                } catch (error) {
                  if (error instanceof ApiError && error.status === 409) {
                    try {
                      await load();
                    } catch (refreshError) {
                      report(refreshError);
                    }
                    setError(t("conflict"));
                  } else report(error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <p>{t("resetHint")}</p>
              <label>
                {t("reason")}
                <textarea name="reason" minLength={10} maxLength={1000} required />
              </label>
              <button disabled={busy}>{t(busy ? "busy" : "reset")}</button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
