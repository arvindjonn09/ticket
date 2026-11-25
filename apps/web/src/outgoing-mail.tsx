import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { OutgoingMailView } from "@astrama/contracts";
import { api, ApiError } from "./api";
import { displayDate } from "./dates";
import type { SessionView } from "./types";
import { OutgoingSmtpForm } from "./outgoing-mail-forms";
import { takeMailHandoff } from "./mail-handoff";

export function microsoftSignInUrl(value: string): string | null {
  try {
    const destination = new URL(value);
    return destination.protocol === "https:" &&
      destination.hostname === "login.microsoftonline.com" &&
      !destination.username &&
      !destination.password &&
      (!destination.port || destination.port === "443")
      ? destination.href
      : null;
  } catch {
    return null;
  }
}

export function OutgoingMailPanel({ session }: { session: SessionView }) {
  const { t } = useTranslation("outgoingMail");
  const cache = useQueryClient();
  const [choice, setChoice] = useState<"platform" | "smtp" | "google" | "microsoft365" | null>(
      null,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [callbackProblem, setCallbackProblem] = useState(
    () =>
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("mailConnect") === "problem",
  );
  const query = useQuery({
    queryKey: ["outgoing-email", session.tenant.id],
    queryFn: () => api<OutgoingMailView>("/admin/outgoing-email"),
    refetchInterval: (query) =>
      query.state.data?.pendingMicrosoft365?.status === "pending" ? 5000 : false,
  });
  useEffect(() => {
    if (session.user.role !== "admin" || !session.mfaVerified) return;
    if (
      location.pathname !== "/organisation" ||
      new URLSearchParams(location.search).get("section") !== "email"
    )
      return;
    const handoff = takeMailHandoff();
    if (!handoff) return;
    setChoice("microsoft365");
    if (handoff === "invalid") {
      setError(t("handoffInvalid"));
      return;
    }
    setBusy(true);
    setNotice(t("confirming"));
    void api<OutgoingMailView>(
      "/admin/outgoing-email/microsoft365/complete",
      { method: "POST", body: JSON.stringify({ handoff }) },
      session.csrfToken,
    )
      .then(async (result) => {
        cache.setQueryData(["outgoing-email", session.tenant.id], result);
        await cache.invalidateQueries({ queryKey: ["outgoing-email", session.tenant.id] });
        setNotice("");
      })
      .catch((error: unknown) => {
        setNotice("");
        setError(
          t(error instanceof ApiError && error.status === 403 ? "handoffDenied" : "handoffFailed"),
        );
        void cache.invalidateQueries({ queryKey: ["outgoing-email", session.tenant.id] });
      })
      .finally(() => setBusy(false));
  }, [session.user.role, session.mfaVerified, session.tenant.id, session.csrfToken, cache, t]);
  const test = useMutation({
    mutationFn: () =>
      api<{ sent: true }>(
        "/admin/operations/email/test",
        { method: "POST", body: "{}" },
        session.csrfToken,
      ),
    onSettled: () => {
      void cache.invalidateQueries({ queryKey: ["email-health"] });
      void query.refetch();
    },
  });
  async function post<T>(path: string, body: object) {
    return api<T>(
      `/admin/outgoing-email/${path}`,
      { method: "POST", body: JSON.stringify(body) },
      session.csrfToken,
    );
  }
  async function change(path: string, body: object, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    setCallbackProblem(false);
    test.reset();
    try {
      const result = await post<OutgoingMailView>(path, body);
      cache.setQueryData(["outgoing-email", session.tenant.id], result);
      void cache.invalidateQueries({ queryKey: ["email-health"] });
      setNotice(t(message));
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await query.refetch();
        setError(t("conflict"));
      } else setError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const view = query.data;
  const selected =
    choice ??
    (view?.pendingMicrosoft365
      ? "microsoft365"
      : view?.mode === "smtp" && view.smtp?.provider === "google"
        ? "google"
        : (view?.mode ?? "platform"));
  const disabled = busy || session.tenant.status === "read_only";
  return (
    <section className="form-panel" aria-labelledby="organisation-email-sending">
      <h2 id="organisation-email-sending">{t("title")}</h2>
      <p>{t("guide")}</p>
      {callbackProblem && (
        <p role="alert" className="error">
          {t("microsoftProblem")}
        </p>
      )}
      {query.isPending ? (
        <p role="status">{t("loading")}</p>
      ) : query.error || !view ? (
        <>
          <p role="alert" className="error">
            {query.error?.message}
          </p>
          <button className="button secondary" onClick={() => void query.refetch()}>
            {t("retry")}
          </button>
        </>
      ) : (
        <>
          <dl>
            {[
              ["configuredMode", t(`modes.${view.mode}`)],
              ["effectiveMode", t(`modes.${view.effectiveMode}`)],
              ["status", t(view.status)],
            ].map(([key, value]) => (
              <div key={key}>
                <dt>{t(key!)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {view.smtp && (
              <>
                <div>
                  <dt>{t("currentFrom")}</dt>
                  <dd>{view.smtp.fromAddress}</dd>
                </div>
                <div>
                  <dt>{t("currentHost")}</dt>
                  <dd>{view.smtp.host}</dd>
                </div>
              </>
            )}
            {view.testedAt && (
              <div>
                <dt>{t("lastTest")}</dt>
                <dd>{displayDate(view.testedAt)}</dd>
              </div>
            )}
          </dl>
          {view.effectiveMode === "platform" && view.mode !== "platform" && (
            <p role="status" className="error">
              {t("fallback")}
            </p>
          )}
          {view.lastError && <p role="status">{view.lastError}</p>}
          <label>
            {t("mode")}
            <select
              value={selected}
              disabled={disabled}
              onChange={(event) => {
                setChoice(event.target.value as typeof choice);
                setError("");
                setNotice("");
                setCallbackProblem(false);
                test.reset();
              }}
            >
              {["platform", "microsoft365", "google", "smtp"].map((mode) => (
                <option key={mode} value={mode}>
                  {t(`modes.${mode}`)}
                </option>
              ))}
            </select>
          </label>
          {selected === "platform" ? (
            <>
              <p>{t("defaultIntro")}</p>
              {(view.mode !== "platform" || view.pendingMicrosoft365) && (
                <>
                  <p>{t("defaultHint")}</p>
                  <button
                    className="button primary"
                    disabled={disabled}
                    onClick={() =>
                      void change("platform", { revision: view.revision }, "defaultSaved")
                    }
                  >
                    {t("useDefault")}
                  </button>
                </>
              )}
            </>
          ) : selected === "smtp" || selected === "google" ? (
            <OutgoingSmtpForm
              key={selected}
              settings={view.smtp}
              provider={selected}
              revision={view.revision}
              busy={busy}
              disabled={session.tenant.status === "read_only"}
              save={(input) => change("smtp/test-and-save", input, "saved")}
            />
          ) : (
            <>
              <p>{t("microsoftGuide")}</p>
              {!view.microsoft365Available && <p>{t("microsoftUnavailable")}</p>}
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  setBusy(true);
                  setError("");
                  setNotice("");
                  setCallbackProblem(false);
                  test.reset();
                  try {
                    const result = await post<{ authorizationUrl: string }>(
                      "microsoft365/connect",
                      {
                        revision: view.revision,
                        mailboxAddress: form.get("mailboxAddress"),
                        fromAddress: form.get("fromAddress"),
                      },
                    );
                    const destination = microsoftSignInUrl(result.authorizationUrl);
                    if (!destination) throw new Error(t("invalidRedirect"));
                    location.assign(destination);
                  } catch (error) {
                    if (error instanceof ApiError && error.status === 409) {
                      await query.refetch();
                      setError(t("conflict"));
                    } else setError(error instanceof Error ? error.message : String(error));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <fieldset disabled={disabled || !view.microsoft365Available}>
                  <label>
                    {t("mailbox")}
                    <input
                      name="mailboxAddress"
                      type="email"
                      required
                      maxLength={254}
                      defaultValue={
                        view.pendingMicrosoft365?.mailboxAddress ??
                        (view.mode === "microsoft365" ? view.smtp?.username : "")
                      }
                    />
                  </label>
                  <label>
                    {t("fromAddress")}
                    <input
                      name="fromAddress"
                      type="email"
                      required
                      maxLength={254}
                      defaultValue={
                        view.pendingMicrosoft365?.fromAddress ??
                        (view.mode === "microsoft365" ? view.smtp?.fromAddress : "")
                      }
                    />
                  </label>
                  <button className="button primary">{t(busy ? "connecting" : "connect")}</button>
                </fieldset>
              </form>
              {view.pendingMicrosoft365 && (
                <>
                  <p role="status">
                    {t("pendingConnection")}: {t(view.pendingMicrosoft365.status)}
                  </p>
                  <p>{t("expires", { date: displayDate(view.pendingMicrosoft365.expiresAt) })}</p>
                  {view.pendingMicrosoft365.error && (
                    <p role="alert" className="error">
                      {view.pendingMicrosoft365.error}
                    </p>
                  )}
                  {view.pendingMicrosoft365.status === "ready" && (
                    <>
                      <p>{t("microsoftReady")}</p>
                      <button
                        className="button primary"
                        disabled={disabled || !view.microsoft365Available}
                        onClick={() =>
                          void change(
                            "microsoft365/test-and-save",
                            {
                              revision: view.revision,
                              connectionId: view.pendingMicrosoft365!.connectionId,
                            },
                            "saved",
                          )
                        }
                      >
                        {t(busy ? "testing" : "testSave")}
                      </button>
                    </>
                  )}
                </>
              )}
            </>
          )}
          <p>{t("currentHint")}</p>
          <button
            className="button secondary"
            disabled={disabled || test.isPending}
            onClick={() => test.mutate()}
          >
            {t(test.isPending ? "testing" : "testCurrent")}
          </button>
          {test.isSuccess && <p role="status">{t("accepted")}</p>}
          {test.error && (
            <p role="alert" className="error">
              {test.error.message}
            </p>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
