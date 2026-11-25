import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, LockKeyhole, MessageSquare } from "lucide-react";
import { api, ApiError } from "../../api";
import { RequestInformation, TicketHistory } from "../approver/completion";
import { Attachments, ReviseRequest } from "../shared/ticket-tools";
import type { TicketDetail } from "../../types";
import { Failure, Loading, Status, date, initials, useSession } from "./support-shared.js";
import { MessageComposer } from "./message-composer.js";
import { TicketSidebar } from "./ticket-sidebar.js";

export function IncidentDetail() {
  const { t } = useTranslation();
  const session = useSession();
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const cache = useQueryClient();
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");
  const [customerSummary, setCustomerSummary] = useState("");
  const detail = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => api<TicketDetail>(`/tickets/${encodeURIComponent(id!)}`),
  });
  const chooseCategory = searchParams.get("choose-category") === "1";
  const emailCategories = useQuery({
    queryKey: ["email-categories", id],
    queryFn: () =>
      api<{ categories: { id: string; name: string }[] }>(
        `/tickets/${encodeURIComponent(id!)}/email-categories`,
      ),
    enabled: chooseCategory,
  });
  const categoryMutation = useMutation({
    mutationFn: (categoryId: string) =>
      api<TicketDetail>(
        `/tickets/${encodeURIComponent(id!)}/email-category`,
        {
          method: "POST",
          body: JSON.stringify({ revision: detail.data!.revision, categoryId }),
        },
        session.csrfToken,
      ),
    onSuccess: (ticket) => {
      cache.setQueryData(["ticket", id], ticket);
      void cache.invalidateQueries({ queryKey: ["tickets"] });
      setSearchParams({}, { replace: true });
    },
  });
  const mutation = useMutation({
    mutationFn: ({ action, data }: { action: string; data: Record<string, unknown> }) =>
      api<TicketDetail>(
        `/tickets/${encodeURIComponent(id!)}/${action}`,
        {
          method: "POST",
          body: JSON.stringify({ revision: detail.data!.revision, ...data }),
        },
        session.csrfToken,
      ),
    onSuccess: (ticket, variables) => {
      cache.setQueryData(["ticket", id], ticket);
      void cache.invalidateQueries({ queryKey: ["tickets"] });
      void cache.invalidateQueries({ queryKey: ["ticket-history", id] });
      if (variables.action === "state") {
        setResolving(false);
        setResolution("");
        setCustomerSummary("");
      }
    },
  });
  if (detail.isPending) return <Loading />;
  if (detail.error)
    return (
      <div className="page">
        <Link className="back-link" to="/tickets">
          <ArrowLeft size={15} />
          {t("back")}
        </Link>
        <Failure
          error={detail.error}
          retry={() => {
            void detail.refetch();
          }}
        />
      </div>
    );
  const ticket = detail.data;
  if (!ticket) return null;
  const isAgent =
    ["agent", "admin"].includes(session.user.role) &&
    session.user.departmentIds.includes(ticket.departmentId);
  const canTransfer =
    ["agent", "admin"].includes(session.user.role) && session.user.departmentIds.length > 0;
  const isRequester = session.user.id === ticket.callerId;
  const closed = ["Complete", "Cancelled", "Rejected"].includes(ticket.state);
  const canMessage =
    !closed && (isAgent || isRequester || ticket.requestedForId === session.user.id);
  const stateChange = (state: string) => mutation.mutate({ action: "state", data: { state } });
  return (
    <div className="page detail-page">
      <Link className="back-link" to="/tickets">
        <ArrowLeft size={15} />
        {t("back")}
      </Link>
      <div className="detail-heading">
        <div className="detail-meta">
          <span className="ticket-number">{ticket.number}</span>
          <span className="meta-separator" />
          <Status state={ticket.state} />
          <span className="priority">{ticket.priority}</span>
        </div>
        <h1>{ticket.summary}</h1>
        {ticket.channel === "Email" && <span className="ticket-channel">Via email</span>}
        {isAgent && ticket.inboundSenderEmail && (
          <p className="detail-byline">
            Email sender: {ticket.inboundSenderEmail}
            {ticket.inboundUnverified ? " (unverified)" : ""}
          </p>
        )}
        <div className="detail-byline">
          {t("reportedBy")}{" "}
          {ticket.inboundUnverified ? (
            <strong>{ticket.callerName}</strong>
          ) : (
            <Link to={`/users/${ticket.callerId}`}>
              <strong>{ticket.callerName}</strong>
            </Link>
          )}
          <span>·</span>
          <time dateTime={ticket.createdAt}>{date(ticket.createdAt, true)}</time>
        </div>
        {ticket.submittedById && ticket.submittedById !== ticket.callerId && (
          <p className="detail-byline">
            {t("submittedBy")}{" "}
            <Link to={`/users/${ticket.submittedById}`}>{ticket.submittedByName}</Link> ·{" "}
            {t("onBehalfOf")} <Link to={`/users/${ticket.callerId}`}>{ticket.callerName}</Link>
          </p>
        )}
      </div>
      {chooseCategory && isRequester && ticket.channel === "Email" && !ticket.inboundUnverified && (
        <section className="form-panel" aria-label="Choose ticket category">
          <h2>Choose a category</h2>
          {emailCategories.error && (
            <p className="error" role="alert">
              {emailCategories.error.message}
            </p>
          )}
          {categoryMutation.error && (
            <p className="error" role="alert">
              {categoryMutation.error.message}
            </p>
          )}
          <label>
            Category
            <select
              aria-label="Category"
              defaultValue=""
              onChange={(event) => {
                if (event.target.value) categoryMutation.mutate(event.target.value);
              }}
              disabled={categoryMutation.isPending}
            >
              <option value="" disabled>
                Select a category
              </option>
              {emailCategories.data?.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        </section>
      )}
      {mutation.error && (
        <Failure
          error={mutation.error}
          retry={
            mutation.error instanceof ApiError && mutation.error.status === 409
              ? () => {
                  void detail.refetch().then(() => mutation.reset());
                }
              : undefined
          }
        />
      )}
      {isRequester && ticket.state === "Resolved" && (
        <section className="confirmation">
          <span className="confirmation-icon">
            <Check size={22} />
          </span>
          <div>
            <h2>{t("confirmTitle")}</h2>
            <p>{t("confirmText")}</p>
          </div>
          <div className="confirmation-actions">
            <button
              className="button secondary"
              disabled={mutation.isPending}
              onClick={() => stateChange("In Progress")}
            >
              {t("reopen")}
            </button>
            <button
              className="button primary"
              disabled={mutation.isPending}
              onClick={() => stateChange("Complete")}
            >
              <Check size={16} />
              {t("confirm")}
            </button>
          </div>
        </section>
      )}
      <div className="detail-grid">
        <div className="detail-main">
          <RequestInformation ticket={ticket} />
          {isAgent && !closed && ticket.type === "request" && (
            <ReviseRequest
              session={session}
              ticket={ticket}
              onSaved={(updated) => {
                cache.setQueryData(["ticket", id], updated);
                void cache.invalidateQueries({ queryKey: ["tickets"] });
                void cache.invalidateQueries({ queryKey: ["approvals"] });
                void cache.invalidateQueries({
                  queryKey: ["ticket-history", id],
                });
              }}
            />
          )}
          <section className="description-panel">
            <h2>{t("description")}</h2>
            <p className="preserve-text">{ticket.description}</p>
          </section>
          <section className="activity-panel">
            <div className="section-heading">
              <MessageSquare size={18} />
              <h2>{t("activity")}</h2>
            </div>
            <div className="timeline">
              {ticket.activities.length === 0 ? (
                <p className="muted no-activity">{t("noActivity")}</p>
              ) : (
                ticket.activities.map((activity) => (
                  <article
                    key={activity.id}
                    className={`activity-entry ${activity.audience === "internal" ? "internal-entry" : ""}`}
                  >
                    <span className="avatar activity-avatar">{initials(activity.authorName)}</span>
                    <div className="activity-content">
                      <div className="activity-author">
                        <strong>{activity.authorName}</strong>
                        {activity.audience === "internal" && (
                          <span className="internal-label">
                            <LockKeyhole size={11} />
                            {t("private")}
                          </span>
                        )}
                        <time dateTime={activity.createdAt}>{date(activity.createdAt, true)}</time>
                      </div>
                      <p className="preserve-text">{activity.body}</p>
                    </div>
                  </article>
                ))
              )}
            </div>
            <MessageComposer
              isAgent={isAgent}
              canMessage={canMessage}
              closed={closed}
              pending={mutation.isPending}
              onSend={async (message, audience) => {
                await mutation.mutateAsync({
                  action: "messages",
                  data: { body: message, audience },
                });
              }}
            />{" "}
          </section>
          <Attachments session={session} ticket={ticket} isAgent={isAgent} closed={closed} />
          <TicketHistory id={ticket.id} />
          {resolving && (
            <section className="form-panel resolution-panel">
              <h2>{t(ticket.type === "request" ? "fulfilRequest" : "resolveTitle")}</h2>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  mutation.mutate({
                    action: "state",
                    data: {
                      state: ticket.type === "request" ? "Complete" : "Resolved",
                      resolution: resolution.trim(),
                      customerSummary: customerSummary.trim(),
                    },
                  });
                }}
              >
                <label>
                  {t("resolution")}
                  <textarea
                    required
                    maxLength={5000}
                    rows={3}
                    value={resolution}
                    onChange={(event) => setResolution(event.target.value)}
                  />
                  <span className="field-hint">{t("resolutionHint")}</span>
                </label>
                <label>
                  {t("customerSummary")}
                  <textarea
                    required
                    maxLength={5000}
                    rows={3}
                    value={customerSummary}
                    onChange={(event) => setCustomerSummary(event.target.value)}
                  />
                  <span className="field-hint">{t("customerSummaryHint")}</span>
                </label>
                <div className="form-actions">
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setResolving(false)}
                  >
                    {t("cancel")}
                  </button>
                  <button
                    className="button primary"
                    disabled={mutation.isPending || !resolution.trim() || !customerSummary.trim()}
                  >
                    {t(
                      mutation.isPending
                        ? "sending"
                        : ticket.type === "request"
                          ? "completeRequest"
                          : "markResolved",
                    )}
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
        <TicketSidebar
          session={session}
          ticket={ticket}
          isAgent={isAgent}
          canTransfer={canTransfer}
          isRequester={isRequester}
          closed={closed}
          pending={mutation.isPending}
          onSaved={(updated) => {
            cache.setQueryData(["ticket", id], updated);
            void cache.invalidateQueries({ queryKey: ["tickets"] });
            void cache.invalidateQueries({ queryKey: ["ticket-history", id] });
          }}
          onClaim={() => mutation.mutate({ action: "claim", data: {} })}
          onStart={() => stateChange("In Progress")}
          onResolve={() => setResolving(true)}
        />
      </div>
    </div>
  );
}
