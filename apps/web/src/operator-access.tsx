import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { SessionView } from "@astrama/contracts";
import i18n from "./i18n";
import { api } from "./api";

i18n.addResourceBundle("en", "operatorAccess", {
  title: "Operator support access",
  scope:
    "A grant permits read-only support and a private full-organisation export by our trusted maintenance operator. Sensitive tickets and internal notes in the console follow your current support groups. You can revoke access at any time.",
  email: "Operator email address",
  find: "Find operator",
  noOperator: "No active operator matches this email.",
  expiry: "Expires (within 24 hours, in your local time zone)",
  reason: "Reason (at least 10 characters)",
  grant: "Grant temporary access",
  granted: "Support access granted.",
  revoke: "Revoke access",
  revoked: "Revoked",
  revokeNamed: "Revoke access for {{operator}}",
  revokeReason: "Revocation reason for {{operator}}",
  active: "Active",
  expired: "Expired",
  grants: "Named operator grants",
  views: "Support view history",
  noGrants: "No support grants.",
  noViews: "No support views recorded.",
  refresh: "Refresh access and history",
  loading: "Loading support access…",
  working: "Working…",
  revokedNotice: "Support access revoked.",
  listViewed: "Ticket list viewed",
  ticketViewed: "Ticket viewed",
  older: "Older views",
});
type Access = {
  operators: { id: string; name: string; email: string }[];
  grants: {
    id: string;
    revision: number;
    expiresAt: string;
    revokedAt: string | null;
    reason: string;
    operator: { name: string; email: string };
  }[];
  views: {
    id: string;
    action: string;
    createdAt: string;
    operator: { name: string; email: string };
  }[];
  nextViewCursor?: string;
};
const localDate = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function OperatorAccessPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation("operatorAccess");
  const [email, setEmail] = useState(""),
    [cursor, setCursor] = useState<string | undefined>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const query = useQuery({
    queryKey: ["operator-access", session.tenant.id, email, cursor],
    queryFn: () =>
      api<Access>(
        `/admin/operator-access?${new URLSearchParams({ ...(email ? { email } : {}), ...(cursor ? { viewCursor: cursor } : {}) })}`,
      ),
  });
  const readOnly = session.tenant.status === "read_only";
  async function post(path: string, body: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, { method: "POST", body: JSON.stringify(body) }, session.csrfToken);
      await query.refetch();
      setNotice(t(path.endsWith("revoke") ? "revokedNotice" : "granted"));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="form-panel">
      <h2>{t("title")}</h2>
      <p>{t("scope")}</p>
      {(error || query.error) && (
        <p role="alert" className="error">
          {error || query.error?.message}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <button
        className="button-secondary"
        onClick={() => {
          setCursor(undefined);
          void query.refetch();
        }}
      >
        {t("refresh")}
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setEmail(String(new FormData(event.currentTarget).get("email")).trim().toLowerCase());
          setCursor(undefined);
        }}
      >
        <label>
          {t("email")}
          <input name="email" type="email" maxLength={254} required />
        </label>
        <button className="button-secondary">{t("find")}</button>
      </form>
      {query.isPending && <p role="status">{t("loading")}</p>}
      {email && query.data && !query.data.operators.length && (
        <p role="status">{t("noOperator")}</p>
      )}
      {query.data?.operators.map((operator) => (
        <form
          key={operator.id}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const existing = query.data?.grants.find(
              (grant) => grant.operator.email === operator.email,
            );
            void post("/admin/operator-access", {
              operatorEmail: operator.email,
              expiresAt: new Date(String(form.get("expiry"))).toISOString(),
              reason: form.get("reason"),
              ...(existing ? { revision: existing.revision } : {}),
            });
          }}
        >
          <fieldset disabled={busy || readOnly}>
            <legend>
              {operator.name} · {operator.email}
            </legend>
            <label>
              {t("expiry")}
              <input
                name="expiry"
                type="datetime-local"
                required
                min={localDate(new Date(Date.now() + 60000))}
                max={localDate(new Date(Date.now() + 24 * 3600000))}
              />
            </label>
            <label>
              {t("reason")}
              <textarea name="reason" required minLength={10} maxLength={1000} />
            </label>
            <button className="button-primary">{t(busy ? "working" : "grant")}</button>
          </fieldset>
        </form>
      ))}
      <h3>{t("grants")}</h3>
      {query.data?.grants.length === 0 && <p>{t("noGrants")}</p>}
      {query.data?.grants.map((grant) => (
        <article className="config-record" key={grant.id}>
          <p>
            <strong>{grant.operator.name}</strong> · {grant.operator.email} ·{" "}
            {t(
              grant.revokedAt
                ? "revoked"
                : new Date(grant.expiresAt) <= new Date()
                  ? "expired"
                  : "active",
            )}
          </p>
          <p>
            {new Date(grant.expiresAt).toLocaleString()} · {grant.reason}
          </p>
          {!grant.revokedAt && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void post("/admin/operator-access/revoke", {
                  grantId: grant.id,
                  revision: grant.revision,
                  reason: new FormData(event.currentTarget).get("reason"),
                });
              }}
            >
              <label>
                {t("revokeReason", { operator: grant.operator.name })}
                <input name="reason" required minLength={10} maxLength={1000} />
              </label>
              <button
                disabled={busy}
                className="button-secondary"
                aria-label={t("revokeNamed", { operator: grant.operator.name })}
              >
                {t("revoke")}
              </button>
            </form>
          )}
        </article>
      ))}
      <h3>{t("views")}</h3>
      {query.data?.views.length === 0 && <p>{t("noViews")}</p>}
      <ol>
        {query.data?.views.map((view) => (
          <li key={view.id}>
            {new Date(view.createdAt).toLocaleString()} · {view.operator.name} (
            {view.operator.email}) ·{" "}
            {t(view.action === "support.ticket.viewed" ? "ticketViewed" : "listViewed")}
          </li>
        ))}
      </ol>
      {query.data?.nextViewCursor && (
        <button className="button-secondary" onClick={() => setCursor(query.data!.nextViewCursor)}>
          {t("older")}
        </button>
      )}
    </section>
  );
}
