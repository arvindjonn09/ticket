import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { QRCodeCanvas } from "qrcode.react";
import type { OperatorSessionView } from "@astrama/contracts";
import i18n from "./i18n";
import { api, ApiError, date, type Call, type Failure, type Organisation, type Plan } from "./api";
import { OrganisationDetail, PlanEditor } from "./organisation";
import { PlatformEmail } from "./platform-email";
import "./style.css";

function Authentication({
  session,
  call,
  signedIn,
  fail,
}: {
  session: OperatorSessionView | null;
  call: Call;
  signedIn: (view: OperatorSessionView) => void;
  fail: Failure;
}) {
  const { t } = useTranslation();
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="auth card">
      <h1>{t(!session ? "signIn" : session.mfaEnrolled ? "verifyTitle" : "setupTitle")}</h1>
      {!session ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            try {
              signedIn(
                await call<OperatorSessionView>("/auth/login", {
                  email: form.get("email"),
                  password: form.get("password"),
                }),
              );
            } catch (error) {
              fail(error);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            {t("email")}
            <input name="email" type="email" autoComplete="username" required maxLength={254} />
          </label>
          <label>
            {t("password")}
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <button disabled={busy}>{t(busy ? "busy" : "signIn")}</button>
        </form>
      ) : (
        <>
          {!session.mfaEnrolled && !setup && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  setSetup(await call("/auth/mfa/setup", {}));
                } catch (error) {
                  fail(error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("beginSetup")}
            </button>
          )}
          {setup && (
            <>
              <p>{t("scanInstructions")}</p>
              <QRCodeCanvas
                value={setup.uri}
                size={256}
                marginSize={4}
                level="M"
                bgColor="#ffffff"
                fgColor="#000000"
                role="img"
                aria-label={t("qrCode")}
                style={{ maxWidth: "100%", height: "auto" }}
              />
              <details>
                <summary>{t("manualSetup")}</summary>
                <p>{t("manualInstructions")}</p>
                <label>
                  {t("secret")}
                  <input value={setup.secret} readOnly autoComplete="off" spellCheck={false} />
                </label>
                <label>
                  {t("uri")}
                  <textarea value={setup.uri} readOnly autoComplete="off" spellCheck={false} />
                </label>
              </details>
            </>
          )}
          {(session.mfaEnrolled || setup) && (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                const code = new FormData(event.currentTarget).get("code");
                setBusy(true);
                try {
                  signedIn(await call<OperatorSessionView>("/auth/mfa/verify", { code }));
                } catch (error) {
                  fail(error);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                {t("code")}
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                />
              </label>
              <button disabled={busy}>{t(busy ? "busy" : "verify")}</button>
            </form>
          )}
        </>
      )}
    </main>
  );
}

function Organisations({
  call,
  fail,
  open,
}: {
  call: Call;
  fail: Failure;
  open: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Organisation[] | null>(null),
    [busy, setBusy] = useState(false);
  const load = useCallback(
    async (search = "") => {
      setBusy(true);
      try {
        setRows(await call(`/organisations?search=${encodeURIComponent(search)}`));
      } catch (error) {
        fail(error);
      } finally {
        setBusy(false);
      }
    },
    [call, fail],
  );
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section>
      <h1>{t("organisations")}</h1>
      <form
        className="search"
        onSubmit={(event) => {
          event.preventDefault();
          void load(String(new FormData(event.currentTarget).get("search") ?? ""));
        }}
      >
        <label>
          {t("search")}
          <input type="search" name="search" maxLength={160} />
        </label>
        <button disabled={busy}>{t("search")}</button>
      </form>
      {!rows ? (
        <p role="status">{t("loading")}</p>
      ) : rows.length === 0 ? (
        <p>{t("noResults")}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {["name", "slug", "status", "plan", "seats", "created", "lastActivity"].map(
                  (key) => (
                    <th scope="col" key={key}>
                      {t(key)}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((org) => (
                <tr key={org.id}>
                  <td>
                    <button
                      className="link"
                      aria-label={t("openOrg", { name: org.name })}
                      onClick={() => open(org.id)}
                    >
                      {org.name}
                    </button>
                  </td>
                  <td>{org.slug}</td>
                  <td>{t(org.active ? org.status : "suspended")}</td>
                  <td>{org.planId ?? "—"}</td>
                  <td>
                    {org.seatsUsed} / {org.seatLimit}
                  </td>
                  <td>{date(org.createdAt)}</td>
                  <td>{date(org.lastActivity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Health({ call, fail }: { call: Call; fail: Failure }) {
  const { t } = useTranslation();
  const [health, setHealth] = useState<{
    healthy: boolean;
    checks: Record<string, boolean>;
    checkedAt: string;
  } | null>(null);
  const load = useCallback(async () => {
    try {
      setHealth(await call("/health"));
    } catch (error) {
      fail(error);
    }
  }, [call, fail]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section>
      <h1>{t("platformHealth")}</h1>
      <button onClick={() => void load()}>{t("refresh")}</button>
      {health ? (
        <>
          <p>
            {t(health.healthy ? "healthy" : "unavailable")} · {t("checkedAt")}:{" "}
            {date(health.checkedAt)}
          </p>
          <dl className="metrics">
            {Object.entries(health.checks).map(([name, healthy]) => (
              <div key={name}>
                <dt>{t(name)}</dt>
                <dd>{t(healthy ? "healthy" : "unavailable")}</dd>
              </div>
            ))}
          </dl>
        </>
      ) : (
        <p role="status">{t("loading")}</p>
      )}
    </section>
  );
}

function Plans({ call, fail, owner }: { call: Call; fail: Failure; owner: boolean }) {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<Plan[]>([]),
    [editing, setEditing] = useState<Plan | null>(null);
  const load = useCallback(async () => {
    try {
      const rows = await call<Plan[]>("/plans");
      setPlans(rows);
      setEditing((current) =>
        current ? (rows.find((plan) => plan.id === current.id) ?? null) : null,
      );
    } catch (error) {
      fail(error);
    }
  }, [call, fail]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <section>
      <h1>{t("plans")}</h1>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {["name", "planId", "stripePriceId", "seatLimit", "interval", "status"].map((key) => (
                <th scope="col" key={key}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.id}>
                <td>
                  {owner ? (
                    <button className="link" onClick={() => setEditing(plan)}>
                      {plan.name}
                    </button>
                  ) : (
                    plan.name
                  )}
                </td>
                <td>{plan.id}</td>
                <td>{plan.stripePriceId}</td>
                <td>{plan.seatLimit}</td>
                <td>{t(plan.billingInterval)}</td>
                <td>{t(plan.active ? "enabled" : "retired")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {owner && (
        <>
          <button onClick={() => setEditing(null)}>{t("newPlan")}</button>
          <PlanEditor
            key={editing?.id ?? "new"}
            plan={editing}
            call={call}
            fail={fail}
            saved={load}
          />
        </>
      )}
    </section>
  );
}

function App() {
  const { t } = useTranslation();
  const [session, setSession] = useState<OperatorSessionView | null>(null),
    [ready, setReady] = useState(false);
  const [error, setError] = useState(""),
    [section, setSection] = useState("organisations"),
    [selected, setSelected] = useState<string | null>(null);
  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) setSession(null);
    setError(failure instanceof Error ? failure.message : i18n.t("requestError"));
  }, []);
  const call = useCallback<Call>(
    (path, body, key) => api(path, session?.csrfToken, body, key),
    [session?.csrfToken],
  );
  useEffect(() => {
    api<OperatorSessionView>("/auth/session")
      .then(setSession)
      .catch((failure) => {
        if (!(failure instanceof ApiError && failure.status === 401)) fail(failure);
      })
      .finally(() => setReady(true));
  }, [fail]);
  return (
    <>
      <header>
        <a href="/" className="brand">
          {t("title")}
        </a>
        {session && (
          <div className="toolbar">
            <span>
              {session.operator.name} · {t(session.operator.role)}
            </span>
            <button
              onClick={async () => {
                try {
                  await call("/auth/logout", {});
                  setSession(null);
                  setSelected(null);
                } catch (failure) {
                  fail(failure);
                }
              }}
            >
              {t("signOut")}
            </button>
          </div>
        )}
      </header>
      <div className="page">
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {!ready ? (
          <p role="status">{t("loading")}</p>
        ) : !session?.mfaVerified ? (
          <Authentication
            key={session?.operator.id ?? "login"}
            session={session}
            call={call}
            fail={fail}
            signedIn={(view) => {
              setError("");
              setSession(view);
            }}
          />
        ) : (
          <>
            <nav aria-label={t("title")}>
              {[
                "organisations",
                "plans",
                "platformHealth",
                ...(session.operator.role === "owner" ? ["platformEmail:title"] : []),
              ].map((key) => (
                <button
                  key={key}
                  aria-pressed={section === key}
                  onClick={() => {
                    setSection(key);
                    setSelected(null);
                    setError("");
                  }}
                >
                  {t(key)}
                </button>
              ))}
            </nav>
            <main>
              {section === "platformEmail:title" && session.operator.role === "owner" ? (
                <PlatformEmail call={call} fail={fail} />
              ) : section === "platformHealth" ? (
                <Health call={call} fail={fail} />
              ) : section === "plans" ? (
                <Plans call={call} fail={fail} owner={session.operator.role === "owner"} />
              ) : selected ? (
                <OrganisationDetail
                  key={selected}
                  id={selected}
                  session={session}
                  call={call}
                  fail={fail}
                  back={() => setSelected(null)}
                />
              ) : (
                <Organisations call={call} fail={fail} open={setSelected} />
              )}
            </main>
            <p className="muted">{t("timesLocal")}</p>
          </>
        )}
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
