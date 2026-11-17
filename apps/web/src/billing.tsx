import React from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { SessionView } from "./types";
import { Failure } from "./workspaces/support/support-shared.js";

type BillingView = {
  status: string;
  readOnlyReason: string | null;
  trialEndsAt: string | null;
  deleteAfter: string | null;
  plan: { id: string; name: string; interval: string } | null;
  seatsUsed: number;
  seatLimit: number;
  hasSubscription: boolean;
  hasCustomer: boolean;
};
type BillingPlan = { id: string; name: string; billingInterval: string; seatLimit: number };

export function Billing({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const [planId, setPlanId] = React.useState("");
  const [invalidRedirect, setInvalidRedirect] = React.useState(false);
  const billing = useQuery({
    queryKey: ["billing", session.tenant.id],
    queryFn: () => api<BillingView>("/billing"),
  });
  const plans = useQuery({
    queryKey: ["billing-plans"],
    queryFn: () => api<BillingPlan[]>("/billing/plans"),
  });
  const redirect = useMutation({
    mutationFn: (input: { path: "checkout" | "portal"; planId?: string }) =>
      api<{ url: string }>(
        `/billing/${input.path}`,
        {
          method: "POST",
          body: JSON.stringify(input.path === "checkout" ? { planId: input.planId } : {}),
        },
        session.csrfToken,
      ),
    onMutate: () => setInvalidRedirect(false),
    onSuccess: ({ url }) => {
      try {
        const target = new URL(url, location.origin);
        if (target.protocol === "https:" || target.origin === location.origin) {
          location.assign(target.href);
          return;
        }
      } catch {
        // Invalid provider destinations are shown to the administrator.
      }
      setInvalidRedirect(true);
    },
  });
  if (billing.isPending) return <p role="status">{t("billing.loading")}</p>;
  if (billing.error) return <Failure error={billing.error} />;
  const data = billing.data;
  const selectedPlanId = planId || data.plan?.id || "";
  const selectedPlan = plans.data?.find((plan) => plan.id === selectedPlanId);
  return (
    <section className="page narrow-page">
      <div className="page-heading">
        <div>
          <h1>{t("billing.title")}</h1>
          <p className="muted">{t("billing.intro")}</p>
        </div>
      </div>
      {data.status === "read_only" && (
        <p className="error" role="status">
          {t("billing.readOnly", {
            date: data.deleteAfter
              ? new Date(data.deleteAfter).toLocaleDateString()
              : t("billing.unknownDate"),
          })}
        </p>
      )}
      <section className="form-panel" aria-labelledby="billing-plan-heading">
        <h2 id="billing-plan-heading">{t("billing.plan")}</h2>
        <dl className="billing-details">
          <div>
            <dt>{t("billing.currentPlan")}</dt>
            <dd>
              {data.plan
                ? `${data.plan.name} · ${t(`billing.${data.plan.interval}`)}`
                : t("billing.noPlan")}
            </dd>
          </div>
          <div>
            <dt>{t("billing.status")}</dt>
            <dd>{t(`billing.statuses.${data.status}`)}</dd>
          </div>
          <div>
            <dt>{t("billing.seats")}</dt>
            <dd>{t("billing.seatCount", { used: data.seatsUsed, limit: data.seatLimit })}</dd>
          </div>
          {data.trialEndsAt && (
            <div>
              <dt>{t("billing.trialEnds")}</dt>
              <dd>{new Date(data.trialEndsAt).toLocaleDateString()}</dd>
            </div>
          )}
        </dl>
        {!(data.status === "active" && data.hasSubscription) && (
          <label>
            {t("billing.choosePlanLabel")}
            <select value={selectedPlanId} onChange={(event) => setPlanId(event.target.value)}>
              <option value="">{t("billing.choosePlanOption")}</option>
              {plans.data?.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} · {t(`billing.${plan.billingInterval}`)} ·{" "}
                  {t("billing.planSeats", { count: plan.seatLimit })}
                </option>
              ))}
            </select>
          </label>
        )}
        {plans.error && <Failure error={plans.error} />}
        <div className="billing-actions">
          {!(data.status === "active" && data.hasSubscription) && (
            <button
              type="button"
              className="button primary"
              disabled={redirect.isPending || !selectedPlan}
              onClick={() => redirect.mutate({ path: "checkout", planId: selectedPlanId })}
            >
              {redirect.isPending ? t("billing.opening") : t("billing.choosePlan")}
            </button>
          )}
          <button
            type="button"
            className="button secondary"
            disabled={redirect.isPending || !data.hasCustomer}
            onClick={() => redirect.mutate({ path: "portal" })}
          >
            {t("billing.manage")}
          </button>
        </div>
        {redirect.error && <Failure error={redirect.error} />}
        {invalidRedirect && <p role="alert">{t("billing.badRedirect")}</p>}
      </section>
    </section>
  );
}

export function Signup() {
  const { t } = useTranslation();
  const [slug, setSlug] = React.useState("");
  const [checkedSlug, setCheckedSlug] = React.useState("");
  const [captcha, setCaptcha] = React.useState("");
  const plans = useQuery({
    queryKey: ["signup-plans"],
    queryFn: () => api<{ id: string; name: string; billingInterval: string }[]>("/signup/plans"),
  });
  const challenge = useQuery({
    queryKey: ["signup-captcha"],
    queryFn: () => api<Record<string, unknown>>("/signup/captcha"),
  });
  React.useEffect(() => {
    const timer = window.setTimeout(() => setCheckedSlug(slug.trim().toLowerCase()), 300);
    return () => window.clearTimeout(timer);
  }, [slug]);
  const availability = useQuery({
    queryKey: ["signup-slug", checkedSlug],
    enabled: /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(checkedSlug),
    queryFn: () =>
      api<{ available: boolean }>(
        `/signup/slug-availability?slug=${encodeURIComponent(checkedSlug)}`,
      ),
  });
  const [verified, setVerified] = React.useState(false);
  React.useEffect(() => {
    let active = true;
    const value = challenge.data;
    if (!value) return;
    if (value.mode === "test") {
      setCaptcha(String(value.token));
      setVerified(true);
      return;
    }
    void import("altcha-lib/v1").then(({ solveChallenge }) => {
      const solved = solveChallenge(
        String(value.challenge),
        String(value.salt),
        String(value.algorithm),
        Number(value.maxnumber ?? value.maxNumber),
      );
      return solved.promise.then((solution) => {
        if (active && solution) {
          const payload = { ...value, number: solution.number };
          setCaptcha(btoa(JSON.stringify(payload)));
          setVerified(true);
        }
      });
    });
    return () => {
      active = false;
    };
  }, [challenge.data]);
  const mutation = useMutation({
    mutationFn: (body: Record<string, string>) =>
      api<{ accepted: boolean; message: string }>("/signup", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void challenge.refetch();
      setVerified(false);
    },
  });
  const verify = useMutation({
    mutationFn: (token: string) =>
      api<{ accepted: boolean; tenantUrl: string }>("/signup/verify", {
        method: "POST",
        body: JSON.stringify({ token }),
      }),
  });
  const search = new URLSearchParams(location.search);
  const token = search.get("token");
  const slugAvailable =
    checkedSlug === slug.trim().toLowerCase() && availability.data?.available === true;
  React.useEffect(() => {
    if (token) verify.mutate(token);
  }, [token]);
  if (token)
    return (
      <main className="page narrow-page activation-page">
        <section className="form-panel">
          <h1>{t("signup.verifying")}</h1>
          {verify.isPending && <p role="status">{t("signup.wait")}</p>}
          {verify.error && <Failure error={verify.error} />}
          {verify.data && (
            <p role="status">
              {t("signup.verified")}{" "}
              <a href={verify.data.tenantUrl}>{t("signup.openOrganisation")}</a>
            </p>
          )}
        </section>
      </main>
    );
  if (mutation.isSuccess)
    return (
      <main className="page narrow-page activation-page">
        <section className="form-panel">
          <h1>{t("signup.title")}</h1>
          <p role="status">{mutation.data.message}</p>
        </section>
      </main>
    );
  return (
    <main className="page narrow-page activation-page">
      <section className="form-panel">
        <h1>{t("signup.title")}</h1>
        <p className="muted">{t("signup.intro")}</p>
        {plans.error && <Failure error={plans.error} />}
        {challenge.error && <Failure error={challenge.error} />}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const values = new FormData(event.currentTarget);
            mutation.mutate({
              slug: String(values.get("slug")).trim().toLowerCase(),
              companyName: String(values.get("companyName")),
              adminName: String(values.get("adminName")),
              adminEmail: String(values.get("adminEmail")),
              timezone: String(values.get("timezone")),
              ...(String(values.get("planId")) ? { planId: String(values.get("planId")) } : {}),
              captcha,
            });
          }}
        >
          <label>
            {t("signup.subdomain")}
            <input
              name="slug"
              required
              minLength={3}
              maxLength={63}
              pattern="[a-z0-9][a-z0-9-]*[a-z0-9]"
              autoCapitalize="none"
              value={slug}
              onChange={(event) => setSlug(event.target.value.toLowerCase())}
              aria-describedby="signup-slug-status"
            />
          </label>
          <p id="signup-slug-status" className="field-hint" role="status">
            {!checkedSlug || checkedSlug !== slug.trim().toLowerCase()
              ? t("signup.slugHint")
              : availability.isFetching
                ? t("signup.slugChecking")
                : slugAvailable
                  ? t("signup.slugAvailable")
                  : t("signup.slugUnavailable")}
          </p>
          <label>
            {t("signup.company")}
            <input name="companyName" required maxLength={120} autoComplete="organization" />
          </label>
          <label>
            {t("signup.adminName")}
            <input name="adminName" required maxLength={120} autoComplete="name" />
          </label>
          <label>
            {t("signup.email")}
            <input name="adminEmail" type="email" required maxLength={254} autoComplete="email" />
          </label>
          <label>
            {t("signup.timezone")}
            <input
              name="timezone"
              required
              defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
            />
          </label>
          <label>
            {t("signup.plan")}
            <select name="planId">
              <option value="">{t("signup.trialPlan")}</option>
              {plans.data?.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.name} · {t(`billing.${plan.billingInterval}`)}
                </option>
              ))}
            </select>
          </label>
          <p className="muted" role="status">
            {verified ? t("signup.captchaReady") : t("signup.captchaChecking")}
          </p>
          <button
            type="submit"
            className="button primary"
            disabled={!verified || !slugAvailable || mutation.isPending}
          >
            {mutation.isPending ? t("signup.sending") : t("signup.submit")}
          </button>
        </form>
        {mutation.error && <Failure error={mutation.error} />}
      </section>
    </main>
  );
}
