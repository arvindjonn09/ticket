import { displayDate } from "../../dates";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../../api";
import { money } from "../../money";
import type { Catalog, SessionView, TicketDetail } from "../../types";

type Person = { id: string; name: string };
export type RequestItem = {
  id: string;
  name: string;
  categoryId: string;
  unitCostMinor: number;
  currency: string;
  recurringPeriod: string | null;
  requiresManager: boolean;
  requiresVp: boolean;
  vpThresholdMinor: number | null;
  alternateApproverId: string | null;
  vpApproverId: string | null;
  active: boolean;
  revision: number;
};
export function ErrorNotice({ error }: { error: Error | null }) {
  const { t } = useTranslation();
  return error ? (
    <p className="error" role="alert">
      {error instanceof ApiError && error.status === 409 ? t("conflict") : error.message}
    </p>
  ) : null;
}
export function ChannelField() {
  const { t } = useTranslation();
  return (
    <label>
      {t("channel")}
      <select name="channel" defaultValue="Self Service">
        {["Self Service", "Email", "Phone", "Walk In"].map((channel) => (
          <option key={channel} value={channel}>
            {t(`channels.${channel}`)}
          </option>
        ))}
      </select>
    </label>
  );
}
export function NewRequest({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [subcategoryId, setSubcategoryId] = useState("");
  const classifications = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("/catalog"),
  });
  const key = useRef(crypto.randomUUID());
  const catalog = useQuery({
    queryKey: ["request-catalog"],
    queryFn: () => api<{ items: RequestItem[]; users: Person[] }>("/requests/catalog"),
  });
  const item = catalog.data?.items.find((row) => row.id === itemId);
  const create = useMutation({
    mutationFn: (body: object) =>
      api<TicketDetail>(
        "/requests",
        {
          method: "POST",
          headers: { "Idempotency-Key": key.current },
          body: JSON.stringify(body),
        },
        session.csrfToken,
      ),
    onSuccess: (ticket) => {
      cache.setQueryData(["ticket", ticket.id], ticket);
      void cache.invalidateQueries({ queryKey: ["tickets"] });
      navigate(`/tickets/${ticket.id}`);
    },
  });
  return (
    <div className="page narrow-page">
      <Link to="/tickets" className="back-link">
        {t("back")}
      </Link>
      <div className="page-heading">
        <div>
          <h1>{t("newRequest")}</h1>
          <p>{t("requestIntro")}</p>
        </div>
      </div>
      <section className="form-panel">
        <ErrorNotice error={catalog.error} />
        {catalog.isPending && <p role="status">{t("loading")}</p>}
        {catalog.data && (
          <form
            onChange={() => {
              key.current = crypto.randomUUID();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              const f = new FormData(event.currentTarget);
              create.mutate({
                itemId,
                requestedForId: String(f.get("requestedForId")),
                quantity,
                summary: String(f.get("summary")).trim(),
                description: String(f.get("description")).trim(),
                justification: String(f.get("justification")).trim(),
                ...(subcategoryId ? { subcategoryId } : {}),
                channel: session.user.role === "agent" ? String(f.get("channel")) : "Self Service",
              });
            }}
          >
            {session.user.role === "agent" && <ChannelField />}
            <label>
              {t("requestItem")}
              <select
                required
                value={itemId}
                onChange={(e) => {
                  setItemId(e.target.value);
                  setSubcategoryId("");
                }}
              >
                <option value="">{t("chooseItem")}</option>
                {catalog.data.items.map((row) => (
                  <option value={row.id} key={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </label>
            {catalog.data.items.length === 0 && <p className="muted">{t("noItems")}</p>}
            {item && (
              <label>
                {t("subcategory")}
                <select value={subcategoryId} onChange={(e) => setSubcategoryId(e.target.value)}>
                  <option value="">{t("noSubcategory")}</option>
                  {classifications.data?.categories
                    .find((category) => category.id === item.categoryId)
                    ?.subcategories.map((row) => (
                      <option key={row.id} value={row.id}>
                        {row.name}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <label>
              {t("requestedFor")}
              <select required name="requestedForId" defaultValue={session.user.id}>
                {catalog.data.users.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("quantity")}
              <input
                type="number"
                required
                min={1}
                max={1000}
                value={quantity}
                onChange={(e) => setQuantity(Number(e.target.value))}
              />
            </label>
            {item && (
              <div className="request-cost" role="status">
                <strong>{money(item.unitCostMinor * quantity, item.currency)}</strong>
                <span>
                  {t(
                    item.recurringPeriod === "month"
                      ? "monthly"
                      : item.recurringPeriod === "year"
                        ? "annual"
                        : "oneTime",
                  )}
                </span>
                <p>
                  {t(
                    item.requiresManager || item.requiresVp || item.vpThresholdMinor !== null
                      ? "approvalRequired"
                      : "approvalNotRequired",
                  )}
                </p>
              </div>
            )}
            <label>
              {t("requestSummary")}
              <input name="summary" required minLength={5} maxLength={160} />
            </label>
            <label>
              {t("requestDescription")}
              <textarea name="description" required minLength={10} maxLength={5000} rows={4} />
            </label>
            <label>
              {t("justification")}
              <textarea name="justification" maxLength={5000} rows={3} />
            </label>
            <ErrorNotice error={create.error} />
            <div className="form-actions">
              <Link className="button secondary" to="/tickets">
                {t("cancel")}
              </Link>
              <button className="button primary" disabled={create.isPending || !item}>
                {t(create.isPending ? "submitting" : "submitRequest")}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
type Approval = {
  id: string;
  ticketId: string;
  number: string;
  summary: string;
  stage: string;
  version: number;
  revision: number;
  requestedForName: string;
  totalCostMinor: number;
  currency: string;
  callerName: string;
  itemName: string;
  justification: string | null;
  createdAt: string;
};
export function Approvals({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [selected, setSelected] = useState<Approval | null>(null);
  const queue = useQuery({
    queryKey: ["approvals"],
    queryFn: () => api<{ approvals: Approval[] }>("/approvals"),
  });
  const decide = useMutation({
    mutationFn: ({
      approval,
      decision,
      comment,
    }: {
      approval: Approval;
      decision: string;
      comment: string;
    }) =>
      api<TicketDetail>(
        `/approvals/${approval.id}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            revision: approval.revision,
            version: approval.version,
            decision,
            ...(comment ? { comment } : {}),
          }),
        },
        session.csrfToken,
      ),
    onSuccess: (ticket) => {
      cache.setQueryData(["ticket", ticket.id], ticket);
      setSelected(null);
      void cache.invalidateQueries({ queryKey: ["approvals"] });
      void cache.invalidateQueries({ queryKey: ["tickets"] });
    },
  });
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>{t("myApprovals")}</h1>
          <p>{t("approvalsIntro")}</p>
        </div>
      </div>
      <ErrorNotice error={queue.error} />
      <ErrorNotice error={decide.error} />
      {(queue.error || decide.error) && (
        <button
          className="text-button"
          onClick={() => {
            void queue.refetch();
            decide.reset();
          }}
        >
          {t("reload")}
        </button>
      )}
      {queue.isPending && <p role="status">{t("loading")}</p>}
      {queue.data?.approvals.length === 0 && (
        <section className="form-panel">
          <p>{t("noApprovals")}</p>
        </section>
      )}
      <div className="approval-list">
        {queue.data?.approvals.map((row) => (
          <article className="form-panel" key={row.id}>
            <div className="section-heading">
              <Link className="ticket-number" to={`/tickets/${row.ticketId}`}>
                {row.number}
              </Link>
              <span className="status">{t(`approvalStage.${row.stage}`)}</span>
            </div>
            <h2>
              <Link to={`/tickets/${row.ticketId}`}>{row.summary}</Link>
            </h2>
            <p className="muted">
              {t("requestedFor")}: {row.requestedForName}
            </p>
            <p className="muted">
              {t("reportedBy")}: {row.callerName} · {row.itemName}
            </p>
            {row.createdAt && (
              <p className="field-hint">
                {t("requestedAt", { date: displayDate(row.createdAt) })} ·{" "}
                {t("waitingHours", {
                  count: Math.max(
                    0,
                    Math.floor((Date.now() - Date.parse(row.createdAt)) / 3600000),
                  ),
                })}
              </p>
            )}
            {row.justification && <p className="preserve-text">{row.justification}</p>}
            <p className="approval-total">{money(row.totalCostMinor, row.currency)}</p>
            <button
              className="button secondary"
              onClick={() => {
                setSelected(row);
                decide.reset();
              }}
            >
              {t("reviewDecision")}
            </button>
            {selected?.id === row.id && (
              <form
                className="decision-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const decision =
                    (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ||
                    "Approved";
                  const comment = String(form.get("comment")).trim();
                  if (decision === "Rejected" && !comment) {
                    const input = event.currentTarget.elements.namedItem(
                      "comment",
                    ) as HTMLTextAreaElement;
                    input.setCustomValidity(t("rejectionReasonRequired"));
                    input.reportValidity();
                    return;
                  }
                  decide.mutate({
                    approval: row,
                    decision,
                    comment,
                  });
                }}
              >
                <p className="field-hint">{t("reviewDetailsHint")}</p>
                <label>
                  {t("decisionComment")}
                  <textarea
                    name="comment"
                    maxLength={2000}
                    rows={3}
                    onChange={(e) => e.target.setCustomValidity("")}
                  />
                </label>
                <div className="form-actions">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setSelected(null)}
                  >
                    {t("cancel")}
                  </button>
                  <button className="button secondary" value="Rejected" disabled={decide.isPending}>
                    {t("reject")}
                  </button>
                  <button className="button primary" value="Approved" disabled={decide.isPending}>
                    {t("approve")}
                  </button>
                </div>
              </form>
            )}
          </article>
        ))}
      </div>
      <Delegations session={session} />
    </div>
  );
}
function Delegations({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const data = useQuery({
    queryKey: ["delegations"],
    queryFn: () =>
      api<{
        delegations: {
          id: string;
          delegateId: string;
          startsAt: string;
          endsAt: string;
          revision: number;
        }[];
        users: Person[];
      }>("/approvals/delegations"),
  });
  const save = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) =>
      api(path, { method: "POST", body: JSON.stringify(body) }, session.csrfToken),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["delegations"] }),
  });
  return (
    <section className="form-panel delegation-panel">
      <h2>{t("delegations")}</h2>
      <p className="muted">{t("delegationIntro")}</p>
      <ErrorNotice error={data.error || save.error} />
      {data.data && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              save.mutate({
                path: "/approvals/delegations",
                body: {
                  delegateId: f.get("delegateId"),
                  startsAt: new Date(String(f.get("startsAt"))).toISOString(),
                  endsAt: new Date(String(f.get("endsAt"))).toISOString(),
                },
              });
            }}
          >
            <label>
              {t("delegate")}
              <select name="delegateId" required defaultValue="">
                <option value="">{t("chooseUser")}</option>
                {data.data.users
                  .filter((u) => u.id !== session.user.id)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="field-grid">
              <label>
                {t("startsAt")}
                <input name="startsAt" type="datetime-local" required />
              </label>
              <label>
                {t("endsAt")}
                <input name="endsAt" type="datetime-local" required />
              </label>
            </div>
            <button className="button primary" disabled={save.isPending}>
              {t("saveDelegation")}
            </button>
          </form>
          {data.data.delegations.map((row) => (
            <div className="config-record" key={row.id}>
              <strong>
                {data.data.users.find((u) => u.id === row.delegateId)?.name || t("delegate")}
              </strong>
              <p>
                {displayDate(row.startsAt)} – {displayDate(row.endsAt)}
              </p>
              <button
                className="text-button"
                disabled={save.isPending}
                onClick={() =>
                  save.mutate({
                    path: `/approvals/delegations/${row.id}/revoke`,
                    body: { revision: row.revision },
                  })
                }
              >
                {t("revoke")}
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
export function RequestInformation({ ticket }: { ticket: TicketDetail }) {
  const { t } = useTranslation();
  if (ticket.type !== "request") return null;
  return (
    <section className="description-panel request-information">
      <h2>{t("requestDetails")}</h2>
      <dl className="request-facts">
        <div>
          <dt>{t("requestItem")}</dt>
          <dd>{ticket.itemName}</dd>
        </div>
        <div>
          <dt>{t("requestedFor")}</dt>
          <dd>
            <Link to={`/users/${ticket.requestedForId}`}>{ticket.requestedForName}</Link>
          </dd>
        </div>
        <div>
          <dt>{t("quantity")}</dt>
          <dd>{ticket.quantity}</dd>
        </div>
        <div>
          <dt>{t("totalCost")}</dt>
          <dd>
            {ticket.totalCostMinor !== null && ticket.currency
              ? money(ticket.totalCostMinor, ticket.currency)
              : "—"}
          </dd>
        </div>
      </dl>
      {ticket.justification && <p className="preserve-text">{ticket.justification}</p>}
      {ticket.approvalCorrectionReason && (
        <p className="error">{ticket.approvalCorrectionReason}</p>
      )}
      <h3>{t("approvalSequence")}</h3>
      {ticket.approvals.length === 0 ? (
        <p className="muted">{t("approvalNotRequired")}</p>
      ) : (
        <ol className="approval-sequence">
          {ticket.approvals.map((row) => (
            <li key={row.id}>
              <strong>{t(`approvalStage.${row.stage}`)}</strong> ·{" "}
              {row.approverName || t("missingApprover")}{" "}
              <span className="status">{t(`approvalStatus.${row.status}`)}</span>
              {row.decidedByName && (
                <p>
                  {t("decidedBy")}: {row.decidedByName}{" "}
                  {row.decidedAt && displayDate(row.decidedAt)}
                </p>
              )}
              {row.comment && <p className="preserve-text">{row.comment}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
export function TicketHistory({ id }: { id: string }) {
  const { t } = useTranslation();
  const history = useQuery({
    queryKey: ["ticket-history", id],
    queryFn: () =>
      api<{
        events: {
          id: string;
          action: string;
          actorName: string;
          createdAt: string;
        }[];
      }>(`/tickets/${id}/history`),
  });
  return (
    <details className="description-panel history-panel">
      <summary>{t("auditHistory")}</summary>
      <ErrorNotice error={history.error} />
      {history.data?.events.map((event) => (
        <div className="config-record" key={event.id}>
          <strong>
            {t(`auditActions.${event.action}`, {
              defaultValue: t("recordUpdated"),
            })}
          </strong>
          <p className="muted">
            {event.actorName} · {displayDate(event.createdAt)}
          </p>
        </div>
      ))}
    </details>
  );
}
export function Reports({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const report = useQuery({
    queryKey: ["reports"],
    queryFn: () =>
      api<{
        total: number;
        byState: { state: string; count: number }[];
        byDepartment: {
          departmentId: string;
          departmentName: string;
          count: number;
        }[];
        limitReached: boolean;
        openCount: number;
        oldestOpenDays: number;
        pendingApprovalCount: number;
        oldestApprovalHours: number;
        medianFirstResponseHours: number | null;
        medianResolutionHours: number | null;
      }>("/reports/summary"),
  });
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>{t("reports")}</h1>
          <p>{t("reportsIntro")}</p>
        </div>
        <a className="button secondary" href="/api/reports/export" download>
          {t("exportReport")}
        </a>
      </div>
      <ErrorNotice error={report.error} />
      {report.isPending && <p role="status">{t("loading")}</p>}
      {report.data && (
        <>
          <div className="metrics">
            <div>
              <span>{t("total")}</span>
              <strong>{report.data.total}</strong>
            </div>
          </div>
          {report.data.limitReached && <p className="field-hint">{t("resultsLimit")}</p>}
          <section className="form-panel report-measures">
            <h2>{t("deliveryMeasures")}</h2>
            <p className="field-hint">{t("calendarHoursHint")}</p>
            <div className="table-scroll">
              <table>
                <tbody>
                  {(
                    [
                      "openCount",
                      "oldestOpenDays",
                      "pendingApprovalCount",
                      "oldestApprovalHours",
                      "medianFirstResponseHours",
                      "medianResolutionHours",
                    ] as const
                  ).map((key) => (
                    <tr key={key}>
                      <th scope="row">{t(`reportMeasures.${key}`)}</th>
                      <td>
                        {report.data[key] === null || report.data[key] === undefined
                          ? "—"
                          : new Intl.NumberFormat(session.tenant.locale || "en", {
                              maximumFractionDigits: 1,
                            }).format(report.data[key])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div className="report-grid">
            <section className="form-panel">
              <h2>{t("status")}</h2>
              {report.data.byState.map((row) => (
                <div className="report-row" key={row.state}>
                  <span>{t(`states.${row.state}`)}</span>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </section>
            <section className="form-panel">
              <h2>{t("supportGroups")}</h2>
              {report.data.byDepartment.map((row) => (
                <div className="report-row" key={row.departmentId}>
                  <span>{row.departmentName}</span>
                  <strong>{row.count}</strong>
                </div>
              ))}
            </section>
          </div>
        </>
      )}
      {session.user.role === "agent" && <Knowledge />}
    </div>
  );
}
function Knowledge() {
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const results = useQuery({
    queryKey: ["knowledge", search],
    queryFn: () =>
      api<{
        tickets: {
          id: string;
          number: string;
          summary: string;
          resolution: string;
        }[];
      }>(`/knowledge?${new URLSearchParams({ search })}`),
    enabled: search.length >= 2,
  });
  return (
    <details className="form-panel delegation-panel">
      <summary>{t("knowledge")}</summary>
      <p className="field-hint">{t("knowledgeIntro")}</p>
      <form
        className="config-form"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(String(new FormData(e.currentTarget).get("search")).trim());
        }}
      >
        <label>
          {t("knowledgeSearch")}
          <input name="search" required minLength={2} maxLength={160} type="search" />
        </label>
        <button className="button secondary">{t("search")}</button>
      </form>
      <ErrorNotice error={results.error} />
      {results.isFetching && <p role="status">{t("loading")}</p>}
      {results.data?.tickets.length === 0 && <p>{t("noKnowledge")}</p>}
      {results.data?.tickets.map((ticket) => (
        <article className="config-record" key={ticket.id}>
          <Link className="ticket-number" to={`/tickets/${ticket.id}`}>
            {ticket.number} · {ticket.summary}
          </Link>
          <p className="preserve-text">{ticket.resolution}</p>
        </article>
      ))}
    </details>
  );
}
export function ApprovalCorrections({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const queue = useQuery({
    queryKey: ["approval-corrections"],
    queryFn: () =>
      api<{
        tickets: {
          id: string;
          number: string;
          summary: string;
          revision: number;
          correctionReason: string;
        }[];
      }>("/admin/approval-corrections"),
  });
  const correct = useMutation({
    mutationFn: ({ id, revision, reason }: { id: string; revision: number; reason: string }) =>
      api(
        `/requests/${id}/correct-approvals`,
        { method: "POST", body: JSON.stringify({ revision, reason }) },
        session.csrfToken,
      ),
    onSuccess: () => cache.invalidateQueries({ queryKey: ["approval-corrections"] }),
  });
  return (
    <section className="form-panel">
      <h2>{t("approvalCorrections")}</h2>
      <p className="muted">{t("correctionsIntro")}</p>
      <ErrorNotice error={queue.error || correct.error} />
      {queue.data?.tickets.length === 0 && <p>{t("noCorrections")}</p>}
      {queue.data?.tickets.map((row) => (
        <form
          className="config-record"
          key={`${row.id}-${row.revision}`}
          onSubmit={(e) => {
            e.preventDefault();
            correct.mutate({
              id: row.id,
              revision: row.revision,
              reason: String(new FormData(e.currentTarget).get("reason")),
            });
          }}
        >
          <strong>
            {row.number} · {row.summary}
          </strong>
          <p className="error">{row.correctionReason}</p>
          <label>
            {t("changeReason")}
            <textarea name="reason" required maxLength={2000} rows={2} />
          </label>
          <button className="button primary" disabled={correct.isPending}>
            {t("retryApprovals")}
          </button>
        </form>
      ))}
    </section>
  );
}
