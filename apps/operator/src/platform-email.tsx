import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { PlatformMailView, PlatformMailDnsView } from "@astrama/contracts";
import { ApiError, date, type Call, type Failure } from "./api";
import { MailProfileForm, MailDnsRecords } from "./mail-profile";

function MailConfirmation({ children, onCancel }: { children: ReactNode; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="card mail-confirmation"
      aria-labelledby="mail-confirm-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {children}
    </dialog>
  );
}

export function PlatformEmail({ call, fail }: { call: Call; fail: Failure }) {
  const { t } = useTranslation("platformEmail");
  const [view, setView] = useState<PlatformMailView | null>(null),
    [tab, setTab] = useState("sending"),
    [selected, setSelected] = useState(""),
    [dns, setDns] = useState<PlatformMailDnsView | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirmation, setConfirmation] = useState<"activate" | "rollback" | null>(null);
  const load = useCallback(async () => {
    const next = await call<PlatformMailView>("/platform-email");
    setView(next);
    setSelected((current) =>
      next.profiles.some((profile) => profile.id === current)
        ? current
        : (next.activeProfileId ?? next.profiles[0]?.id ?? ""),
    );
  }, [call]);
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
  async function perform(action: () => Promise<unknown>, message?: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (message) setNotice(t(message));
      try {
        await load();
      } catch (refreshError) {
        report(refreshError);
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setConfirmation(null);
        setDns(null);
        try {
          await load();
        } catch (refreshError) {
          report(refreshError);
        }
        setError(t("conflict"));
      } else report(error);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const profile = view?.profiles.find((profile) => profile.id === selected);
  const previousProfile = view?.profiles.find((profile) => profile.id === view.previousProfileId);
  return (
    <section aria-labelledby="platform-email-title">
      <h1 id="platform-email-title">{t("title")}</h1>
      <div className="toolbar">
        {["sending", "receiving"].map((value) => (
          <button
            key={value}
            aria-pressed={tab === value}
            onClick={() => {
              setTab(value);
              setError("");
              setNotice("");
            }}
          >
            {t(value)}
          </button>
        ))}
        <button disabled={busy} onClick={() => void perform(async () => undefined)}>
          {t("refresh")}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {!view ? (
        <p role="status">{t("loading")}</p>
      ) : (
        <>
          <section className="card" aria-labelledby="mail-health-title">
            <h2 id="mail-health-title">{t("health")}</h2>
            <dl className="metrics">
              {["sent", "failed"].map((key) => (
                <div key={key}>
                  <dt>{t(key)}</dt>
                  <dd>{view.health[key as "sent" | "failed"]}</dd>
                </div>
              ))}
              <div>
                <dt>{t("bounceRate")}</dt>
                <dd>
                  {view.health.bounceRate === null
                    ? t("unknown")
                    : `${(view.health.bounceRate * 100).toFixed(1)}%`}
                </dd>
              </div>
            </dl>
            {(view.health.junkRisk || (view.health.bounceRate ?? 0) > 0.05) && (
              <p role="status" className="error">
                {t("junkRisk")}
              </p>
            )}
          </section>
          {tab === "sending" ? (
            <>
              <p>{t("intro")}</p>
              <MailProfileForm
                busy={busy}
                save={(input) =>
                  perform(async () => {
                    const result = await call<{ id: string }>("/platform-email/profiles", input);
                    setSelected(result.id);
                    setDns(null);
                  }, "saved")
                }
              />
              <section className="card" aria-labelledby="mail-profiles-title">
                <h2 id="mail-profiles-title">{t("profiles")}</h2>
                {!view.profiles.length ? (
                  <p>{t("noProfiles")}</p>
                ) : (
                  <>
                    <label>
                      {t("selectProfile")}
                      <select
                        value={selected}
                        onChange={(event) => {
                          setSelected(event.target.value);
                          setDns(null);
                          setConfirmation(null);
                        }}
                      >
                        {view.profiles.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name || item.fromAddress} —{" "}
                            {t(item.active ? "active" : item.testedAt ? "tested" : "draft")}
                          </option>
                        ))}
                      </select>
                    </label>
                    {profile && (
                      <>
                        <dl className="metrics">
                          <div>
                            <dt>{t("host")}</dt>
                            <dd>
                              {profile.host}:{profile.port} ({t(profile.security)})
                            </dd>
                          </div>
                          <div>
                            <dt>{t("fromAddress")}</dt>
                            <dd>{profile.fromAddress}</dd>
                          </div>
                          <div>
                            <dt>{t("password")}</dt>
                            <dd>{t(profile.passwordSet ? "passwordSet" : "unknown")}</dd>
                          </div>
                          <div>
                            <dt>{t("status")}</dt>
                            <dd>{t(profile.testedAt ? "tested" : "untested")}</dd>
                          </div>
                        </dl>
                        <div className="toolbar">
                          <button
                            disabled={busy}
                            onClick={() =>
                              void perform(
                                () => call(`/platform-email/profiles/${profile.id}/test`, {}),
                                "testPassed",
                              )
                            }
                          >
                            {t("test")}
                          </button>
                          <button
                            disabled={busy || !profile.testedAt || profile.active}
                            onClick={() => setConfirmation("activate")}
                          >
                            {t("activate")}
                          </button>
                          <button
                            disabled={busy || !view.previousProfileId}
                            onClick={() => setConfirmation("rollback")}
                          >
                            {t("rollback")}
                          </button>
                        </div>
                        <h3>{t("dns")}</h3>
                        <p>{t("dnsHint")}</p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void perform(async () =>
                              setDns(
                                await call<PlatformMailDnsView>(
                                  `/platform-email/profiles/${profile.id}/dns-check`,
                                  {},
                                ),
                              ),
                            )
                          }
                        >
                          {t("checkDns")}
                        </button>
                        {dns && <MailDnsRecords records={dns.records} />}
                      </>
                    )}
                  </>
                )}
              </section>
            </>
          ) : (
            <section className="card" aria-labelledby="receiving-title">
              <h2 id="receiving-title">{t("receiving")}</h2>
              <p>{t("receivingIntro")}</p>
              <dl className="metrics">
                {["domain", "mx", "lastReceived", "queueDepth", "rejected", "testStatus"].map(
                  (key) => (
                    <div key={key}>
                      <dt>{t(key)}</dt>
                      <dd>
                        {key === "domain"
                          ? (view.receiving.domain ?? t("unknown"))
                          : key === "mx"
                            ? t(view.receiving.mxOk ? "pass" : "problem")
                            : key === "lastReceived"
                              ? date(view.receiving.lastReceivedAt)
                              : key === "testStatus"
                                ? t(
                                    view.receiving.testStatus === "problem"
                                      ? "problemStatus"
                                      : (view.receiving.testStatus ?? "not_set_up"),
                                  )
                                : view.receiving[key as "queueDepth" | "rejected"]}
                      </dd>
                    </div>
                  ),
                )}
              </dl>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const address = String(new FormData(event.currentTarget).get("address")).trim();
                  void perform(
                    () => call("/platform-email/receiving/test", { address }),
                    "intakePending",
                  );
                }}
              >
                <label>
                  {t("intakeAddress")}
                  <input name="address" type="email" required maxLength={254} />
                </label>
                <button disabled={busy || !view.receiving.domain}>{t("testIntake")}</button>
              </form>
            </section>
          )}
          {confirmation && (
            <MailConfirmation
              onCancel={() => {
                if (!busy) setConfirmation(null);
              }}
            >
              <h2 id="mail-confirm-title">{t("confirm")}</h2>
              <p>
                {t(confirmation === "activate" ? "activate" : "rollback")}:{" "}
                {confirmation === "activate"
                  ? profile?.name || profile?.fromAddress
                  : previousProfile?.name || previousProfile?.fromAddress || t("previous")}
              </p>
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const result = await perform(
                    () =>
                      call(`/platform-email/${confirmation}`, {
                        revision: view.revision,
                        ...(confirmation === "activate" ? { profileId: profile?.id } : {}),
                        totpCode: form.get("totpCode"),
                        reason: form.get("reason"),
                      }),
                    "activated",
                  );
                  if (result) setConfirmation(null);
                }}
              >
                <label>
                  {t("totp")}
                  <input
                    name="totpCode"
                    autoFocus
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    minLength={6}
                    maxLength={6}
                    autoComplete="one-time-code"
                    required
                  />
                </label>
                <label>
                  {t("reason")}
                  <textarea name="reason" minLength={10} maxLength={1000} required />
                </label>
                <div className="toolbar">
                  <button disabled={busy}>{t(busy ? "busy" : "submit")}</button>
                  <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>
                    {t("cancel")}
                  </button>
                </div>
              </form>
            </MailConfirmation>
          )}
        </>
      )}
    </section>
  );
}
