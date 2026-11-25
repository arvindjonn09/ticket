import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  operatorActionSchema,
  operatorPlanSchema,
  type OperatorSessionView,
} from "@astrama/contracts";
import { ApiError, date, type Call, type Failure, type Organisation, type Plan } from "./api";

export function PlanEditor({
  plan,
  call,
  fail,
  saved,
}: {
  plan: Plan | null;
  call: Call;
  fail: Failure;
  saved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  return (
    <section className="card">
      <h2>{t(plan ? "editPlan" : "newPlan")}</h2>
      <p>{t("assignedPlanHelp")}</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const element = event.currentTarget,
            form = new FormData(element);
          setBusy(true);
          setNotice("");
          try {
            await call(
              "/plans",
              operatorPlanSchema.parse({
                id: form.get("id"),
                name: form.get("name"),
                stripePriceId: form.get("price"),
                seatLimit: Number(form.get("seats")),
                billingInterval: form.get("interval"),
                active: form.get("active") === "on",
                reason: form.get("reason"),
                revision: plan?.revision ?? 0,
              }),
            );
            await saved();
            if (!plan) element.reset();
            setNotice(t("planSaved"));
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="fields">
          <label>
            {t("planId")}
            <input name="id" defaultValue={plan?.id} readOnly={!!plan} required maxLength={80} />
          </label>
          <label>
            {t("name")}
            <input name="name" defaultValue={plan?.name} required maxLength={120} />
          </label>
          <label>
            {t("stripePriceId")}
            <input
              name="price"
              defaultValue={plan?.stripePriceId}
              pattern="price_[A-Za-z0-9_]+"
              required
              maxLength={255}
            />
          </label>
          <label>
            {t("seatLimit")}
            <input
              name="seats"
              type="number"
              min={1}
              max={2147483647}
              defaultValue={plan?.seatLimit}
              required
            />
          </label>
          <label>
            {t("interval")}
            <select name="interval" defaultValue={plan?.billingInterval ?? ""} required>
              <option value="">{t("choose")}</option>
              <option value="month">{t("month")}</option>
              <option value="year">{t("year")}</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input name="active" type="checkbox" defaultChecked={plan?.active ?? false} />
          {t("available")}
        </label>
        <label>
          {t("reason")}
          <textarea name="reason" minLength={10} maxLength={1000} required />
        </label>
        <button disabled={busy}>{t(busy ? "busy" : "savePlan")}</button>
        <p role="status">{notice}</p>
      </form>
    </section>
  );
}

function Actions({
  org,
  plans,
  owner,
  call,
  fail,
  done,
}: {
  org: Organisation;
  plans: Plan[];
  owner: boolean;
  call: Call;
  fail: Failure;
  done: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [action, setAction] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const choices = [
    "resend-invite",
    "mfa-recovery",
    "extend-trial",
    "export",
    ...(owner
      ? ["set-plan", "suspend", "reactivate", "extend-retention", "schedule-deletion"]
      : []),
  ];
  return (
    <section className="card">
      <h2>{t("actions")}</h2>
      <form
        onChange={() => setRequestId(crypto.randomUUID())}
        onSubmit={async (event) => {
          event.preventDefault();
          const element = event.currentTarget,
            form = new FormData(element);
          const payload: Record<string, unknown> = {
            action,
            reason: form.get("reason"),
            revision: org.revision,
          };
          if (["resend-invite", "mfa-recovery"].includes(action))
            payload.userId = form.get("userId");
          if (action === "mfa-recovery") {
            payload.verificationEvidence = form.get("evidence");
            payload.verified = form.get("verified") === "on";
          }
          if (action === "extend-trial") payload.trialEndsAt = new Date(String(form.get("expiry")));
          if (["extend-retention", "schedule-deletion"].includes(action))
            payload.deleteAfter = new Date(String(form.get("expiry")));
          if (action === "set-plan") {
            payload.planId = form.get("planId");
            payload.seatLimit = Number(form.get("seats"));
            payload.prorationBehavior = form.get("proration");
          }
          if (action === "schedule-deletion") {
            payload.expectedSlug = form.get("slug");
            payload.confirmed = form.get("confirmed") === "on";
          }
          setBusy(true);
          setNotice("");
          try {
            const result = await call<{ jobId?: string }>(
              `/organisations/${org.id}/actions`,
              operatorActionSchema.parse(payload),
              requestId,
            );
            setNotice(
              result.jobId ? `${t("queuedNotice")} ${t("jobId")}: ${result.jobId}` : t("accepted"),
            );
            setAction("");
            element.reset();
            setRequestId(crypto.randomUUID());
            await done();
          } catch (error) {
            fail(error);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t("action")}
          <select value={action} onChange={(event) => setAction(event.target.value)} required>
            <option value="">{t("choose")}</option>
            {choices.map((key) => (
              <option key={key} value={key}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>
        {["resend-invite", "mfa-recovery"].includes(action) && (
          <label>
            {t("administrator")}
            <select name="userId" required defaultValue="">
              <option value="">{t("choose")}</option>
              {org.adminContacts
                ?.filter((admin) =>
                  action === "resend-invite" ? !admin.active : admin.active && admin.mfaEnrolled,
                )
                .map((admin) => (
                  <option value={admin.id} key={admin.id}>
                    {admin.name} ({admin.email})
                  </option>
                ))}
            </select>
          </label>
        )}
        {action === "mfa-recovery" && (
          <>
            <label>
              {t("evidence")}
              <textarea name="evidence" minLength={10} maxLength={1000} required />
            </label>
            <label className="check">
              <input type="checkbox" name="verified" required />
              {t("verified")}
            </label>
          </>
        )}
        {["extend-trial", "extend-retention", "schedule-deletion"].includes(action) && (
          <label>
            {t("expiry")}
            <input name="expiry" type="datetime-local" required />
          </label>
        )}
        {action === "set-plan" && (
          <>
            <label>
              {t("plan")}
              <select name="planId" required defaultValue="">
                <option value="">{t("choose")}</option>
                {plans
                  .filter((plan) => plan.active)
                  .map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {t("seatLimit")}
              <input
                type="number"
                name="seats"
                min={Math.max(1, org.seatsUsed)}
                max={2147483647}
                defaultValue={org.seatLimit}
                required
              />
            </label>
            <label>
              {t("proration")}
              <select name="proration" required defaultValue="">
                <option value="">{t("choose")}</option>
                <option value="none">{t("none")}</option>
                <option value="create_prorations">{t("create_prorations")}</option>
              </select>
            </label>
            <p className="muted">{t("billingHelp")}</p>
          </>
        )}
        {action === "schedule-deletion" && (
          <>
            <label>
              {t("typeSlug")} ({org.slug})
              <input name="slug" pattern={org.slug} required autoComplete="off" />
            </label>
            <label className="check">
              <input name="confirmed" type="checkbox" required />
              {t("confirmDelete")}
            </label>
          </>
        )}
        {action && (
          <>
            <label>
              {t("reason")}
              <textarea name="reason" minLength={10} maxLength={1000} required />
            </label>
            <button disabled={busy}>{t(busy ? "busy" : "submit")}</button>
          </>
        )}
        <p role="status">{notice}</p>
      </form>
    </section>
  );
}

type Ticket = {
  id: string;
  number: string;
  summary: string;
  state: string;
  description?: string;
  activities?: {
    id: string;
    body: string;
    audience: string;
    createdAt: string;
    author: { name: string };
  }[];
};
function SupportTickets({ orgId, call, fail }: { orgId: string; call: Call; fail: Failure }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Ticket[] | null>(null),
    [ticket, setTicket] = useState<Ticket | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(),
    [denied, setDenied] = useState(false),
    [busy, setBusy] = useState(false);
  async function load(next?: string) {
    setBusy(true);
    setDenied(false);
    try {
      const result = await call<{ tickets: Ticket[]; nextCursor?: string }>(
        `/organisations/${orgId}/tickets${next ? `?cursor=${encodeURIComponent(next)}` : ""}`,
      );
      setRows((old) => (next ? [...(old ?? []), ...result.tickets] : result.tickets));
      setCursor(result.nextCursor);
      setTicket(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setRows(null);
        setTicket(null);
        setDenied(true);
      } else fail(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>{t("supportView")}</h2>
      <p>{t("readOnlyNotice")}</p>
      <button disabled={busy} onClick={() => void load()}>
        {t(rows ? "refresh" : "loadTickets")}
      </button>
      {denied && <p role="alert">{t("grantRequired")}</p>}
      {ticket ? (
        <article>
          <button onClick={() => setTicket(null)}>{t("closeTicket")}</button>
          <h3>
            {ticket.number}: {ticket.summary}
          </h3>
          <p className="preserve">{ticket.description}</p>
          <h4>{t("messages")}</h4>
          {ticket.activities?.map((entry) => (
            <article className="message" key={entry.id}>
              <p>
                <strong>{t(entry.audience)}</strong> · {entry.author.name} · {date(entry.createdAt)}
              </p>
              <p className="preserve">{entry.body}</p>
            </article>
          ))}
        </article>
      ) : (
        rows && (
          <>
            {rows.length === 0 ? (
              <p>{t("noTickets")}</p>
            ) : (
              <ul className="tickets">
                {rows.map((row) => (
                  <li key={row.id}>
                    <button
                      className="link"
                      onClick={async () => {
                        try {
                          setTicket(await call(`/organisations/${orgId}/tickets/${row.id}`));
                        } catch (error) {
                          if (error instanceof ApiError && error.status === 403) {
                            setRows(null);
                            setTicket(null);
                            setDenied(true);
                          } else fail(error);
                        }
                      }}
                    >
                      {row.number}: {row.summary}
                    </button>{" "}
                    <span>{row.state}</span>
                  </li>
                ))}
              </ul>
            )}
            {cursor && (
              <button disabled={busy} onClick={() => void load(cursor)}>
                {t("more")}
              </button>
            )}
          </>
        )
      )}
    </section>
  );
}

export function OrganisationDetail({
  id,
  session,
  call,
  fail,
  back,
}: {
  id: string;
  session: OperatorSessionView;
  call: Call;
  fail: Failure;
  back: () => void;
}) {
  const { t } = useTranslation();
  const [org, setOrg] = useState<Organisation | null>(null),
    [plans, setPlans] = useState<Plan[]>([]);
  const [jobs, setJobs] = useState<
    { id: string; kind: string; status: string; createdAt: string; lastError: string | null }[]
  >([]);
  const load = useCallback(async () => {
    try {
      const [organisation, configuredPlans, recentJobs] = await Promise.all([
        call<Organisation>(`/organisations/${id}`),
        call<Plan[]>("/plans"),
        call<typeof jobs>(`/organisations/${id}/jobs`),
      ]);
      setOrg(organisation);
      setPlans(configuredPlans);
      setJobs(recentJobs);
    } catch (error) {
      fail(error);
    }
  }, [id, call, fail]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!org) return <p role="status">{t("loading")}</p>;
  return (
    <>
      <button onClick={back}>{t("back")}</button>
      <div className="title-row">
        <h1>{org.name}</h1>
        <button onClick={() => void load()}>{t("refresh")}</button>
      </div>
      <p>
        {org.slug} · {t(org.active ? org.status : "suspended")}
      </p>
      <dl className="metrics">
        {[
          ["plan", org.planId ?? "—"],
          ["seats", `${org.seatsUsed} / ${org.seatLimit}`],
          ["trialEnds", date(org.trialEndsAt)],
          ["deleteAfter", date(org.deleteAfter)],
        ].map(([key, value]) => (
          <div key={key}>
            <dt>{t(key!)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <div className="columns">
        <section className="card">
          <h2>{t("contacts")}</h2>
          {org.adminContacts?.length ? (
            <ul>
              {org.adminContacts.map((admin) => (
                <li key={admin.id}>
                  <strong>{admin.name}</strong>
                  <p>
                    {admin.email} ·{" "}
                    {t(!admin.active ? "pending" : admin.mfaEnrolled ? "enrolled" : "active")}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("noContacts")}</p>
          )}
        </section>
        <section className="card">
          <h2>{t("orgHealth")}</h2>
          <dl>
            {Object.entries(org.health ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt>{t(key)}</dt>
                <dd>
                  {value === null
                    ? t("unknown")
                    : key.startsWith("last")
                      ? date(String(value))
                      : value}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      </div>
      <Actions
        org={org}
        plans={plans}
        owner={session.operator.role === "owner"}
        call={call}
        fail={fail}
        done={load}
      />
      <section className="card">
        <h2>{t("jobs")}</h2>
        <p>{t("privateExport")}</p>
        {jobs.length === 0 ? (
          <p>{t("noJobs")}</p>
        ) : (
          <ul>
            {jobs.map((job) => (
              <li key={job.id}>
                <strong>
                  {t(job.kind)} · {t(job.status)}
                </strong>
                <p>
                  {date(job.createdAt)} · {job.id}
                </p>
                {job.lastError && <p>{job.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
      <SupportTickets orgId={id} call={call} fail={fail} />
      <section className="card">
        <h2>{t("timeline")}</h2>
        <ol>
          {org.timeline?.map((event, index) => (
            <li key={`${event.at}:${index}`}>
              {date(event.at)} · {event.action}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
