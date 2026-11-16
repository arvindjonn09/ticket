import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, CirclePlus, Inbox, Search, X } from "lucide-react";
import { api } from "../../api";
import type { Catalog, TicketSummary } from "../../types";
import { states, Failure, Loading, Status, date, useSession } from "./support-shared.js";

export function TicketList() {
  const { t } = useTranslation();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const scope = params.get("scope") === "mine" || session.user.role === "employee" ? "mine" : "all";
  const search = params.get("search") || "";
  const state = params.get("state") || "";
  const priority = params.get("priority") || "";
  const type = params.get("type") || "";
  const assigned = params.get("assigned") || "";
  const departmentId = params.get("departmentId") || "";
  const untriaged = params.get("untriaged") || "";
  const categoryId = params.get("categoryId") || "";
  const channel = params.get("channel") || "";
  const assignedToId = params.get("assignedToId") || "";
  const cursor = params.get("cursor") || "";
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("/catalog"),
  });
  const queryString = new URLSearchParams({
    scope,
    ...(search ? { search } : {}),
    ...(state ? { state } : {}),
    ...(priority ? { priority } : {}),
    ...(type ? { type } : {}),
    ...(assigned ? { assigned } : {}),
    ...(departmentId ? { departmentId } : {}),
    ...(untriaged ? { untriaged } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(channel ? { channel } : {}),
    ...(assignedToId ? { assignedToId } : {}),
    ...(cursor ? { cursor } : {}),
    limit: "50",
  }).toString();
  const tickets = useQuery({
    queryKey: ["tickets", queryString],
    queryFn: () =>
      api<{ tickets: TicketSummary[]; nextCursor: string | null; limitReached: boolean }>(
        `/tickets?${queryString}`,
      ),
  });
  const records = tickets.data?.tickets || [];
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.delete("cursor");
    if (key === "assigned") next.delete("assignedToId");
    if (key === "assignedToId") next.delete("assigned");
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t("serviceDesk")}</div>
          <h1>{t(scope === "mine" ? "myTickets" : "listTitle")}</h1>
          <p>{t(session.user.role === "agent" ? "listIntroAgent" : "listIntroEmployee")}</p>
        </div>
        <div className="heading-actions">
          <Link className="button secondary" to="/requests/new">
            {t("newRequest")}
          </Link>
          <Link className="button primary" to="/tickets/new">
            <CirclePlus size={17} />
            {t("newIncident")}
          </Link>
        </div>
      </div>
      <div className="metrics" aria-live="polite">
        {[
          { key: "total", count: records.length },
          {
            key: "active",
            count: records.filter((ticket) =>
              ["Open", "In Progress", "On Hold", "Pending Approval"].includes(ticket.state),
            ).length,
          },
          {
            key: "needsConfirmation",
            count: records.filter((ticket) => ticket.state === "Resolved").length,
          },
          {
            key: "completed",
            count: records.filter((ticket) => ticket.state === "Complete").length,
          },
        ].map((metric) => (
          <div key={metric.key}>
            <span>{t(metric.key)}</span>
            <strong>{tickets.isPending || tickets.isError ? "—" : metric.count}</strong>
          </div>
        ))}
      </div>
      <section className="ticket-panel">
        <div className="list-toolbar">
          <form
            role="search"
            className="search-field"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              update("search", String(form.get("search")).trim());
            }}
          >
            <Search size={17} />
            <input
              key={search}
              name="search"
              aria-label={t("search")}
              placeholder={t("searchPlaceholder")}
              defaultValue={search}
            />
            {search && (
              <button
                className="icon-button"
                type="button"
                aria-label={t("cancel")}
                onClick={() => update("search", "")}
              >
                <X size={14} />
              </button>
            )}
          </form>
          <div className="queue-filters">
            <select
              aria-label={t("categoryFilter")}
              value={categoryId}
              onChange={(e) => update("categoryId", e.target.value)}
            >
              <option value="">{t("allCategories")}</option>
              {catalog.data?.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <select
              aria-label={t("channelFilter")}
              value={channel}
              onChange={(e) => update("channel", e.target.value)}
            >
              <option value="">{t("allChannels")}</option>
              {["Self Service", "Email", "Phone", "Walk In"].map((value) => (
                <option key={value} value={value}>
                  {t(`channels.${value}`)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("typeFilter")}
              value={type}
              onChange={(e) => update("type", e.target.value)}
            >
              <option value="">{t("allTypes")}</option>
              <option value="incident">{t("incidents")}</option>
              <option value="request">{t("requests")}</option>
            </select>
            <select
              aria-label={t("priorityFilter")}
              value={priority}
              onChange={(e) => update("priority", e.target.value)}
            >
              <option value="">{t("allPriorities")}</option>
              {["P1", "P2", "P3", "P4", "P5"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            {session.user.role !== "employee" && (
              <>
                <select
                  aria-label={t("agentFilter")}
                  value={assignedToId}
                  onChange={(e) => update("assignedToId", e.target.value)}
                >
                  <option value="">{t("allAgents")}</option>
                  {catalog.data?.agents?.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("assignmentFilter")}
                  value={assigned}
                  onChange={(e) => update("assigned", e.target.value)}
                >
                  <option value="">{t("allAssignments")}</option>
                  <option value="unassigned">{t("unassigned")}</option>
                  <option value="me">{t("assignedToMe")}</option>
                </select>
                <select
                  aria-label={t("groupFilter")}
                  value={departmentId}
                  onChange={(e) => update("departmentId", e.target.value)}
                >
                  <option value="">{t("allGroups")}</option>
                  {catalog.data?.departments.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={t("triageFilter")}
                  value={untriaged}
                  onChange={(e) => update("untriaged", e.target.value)}
                >
                  <option value="">{t("allTriage")}</option>
                  <option value="true">{t("needsTriage")}</option>
                  <option value="false">{t("triaged")}</option>
                </select>
              </>
            )}
            <div className="select-wrap">
              <select
                aria-label={t("stateFilter")}
                value={state}
                onChange={(event) => update("state", event.target.value)}
              >
                <option value="">{t("allStates")}</option>
                {states.map((value) => (
                  <option key={value} value={value}>
                    {t(`states.${value}`)}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
          </div>
        </div>
        {tickets.isPending ? (
          <Loading />
        ) : tickets.error ? (
          <Failure
            error={tickets.error}
            retry={() => {
              void tickets.refetch();
            }}
          />
        ) : records.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Inbox size={28} />
            </span>
            <h2>{t("emptyTitle")}</h2>
            <p>{t("emptyText")}</p>
            <Link to="/tickets/new" className="button secondary">
              {t("newIncident")}
              <ArrowRight size={15} />
            </Link>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("number")}</th>
                    <th>{t("subject")}</th>
                    <th>{t("status")}</th>
                    <th>{t("priority")}</th>
                    <th>{t("sla.timeToBreach")}</th>
                    <th>{t("team")}</th>
                    <th>{t("updated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((ticket) => (
                    <tr key={ticket.id}>
                      <td>
                        <Link className="ticket-number" to={`/tickets/${ticket.id}`}>
                          {ticket.number}
                        </Link>
                      </td>
                      <td>
                        <Link className="ticket-summary" to={`/tickets/${ticket.id}`}>
                          {ticket.summary}
                        </Link>
                        <span className="table-caption">
                          <Link to={`/users/${ticket.callerId}`}>{ticket.callerName}</Link>
                          {ticket.requestedForName && <> · {ticket.requestedForName}</>}
                        </span>
                      </td>
                      <td>
                        <Status state={ticket.state} />
                      </td>
                      <td>
                        <span className={`priority priority-${ticket.priority}`}>
                          {ticket.priority}
                        </span>
                      </td>
                      <td>
                        {(() => {
                          if (
                            ["Resolved", "Complete", "Cancelled", "Rejected"].includes(ticket.state)
                          )
                            return t("sla.dueNone");
                          const due = ticket.slaFirstRespondedAt
                            ? ticket.slaResolutionDueAt
                            : ticket.slaFirstResponseDueAt;
                          if (!due) return t("sla.dueNone");
                          const remaining = Date.parse(due) - Date.now();
                          return remaining < 0
                            ? t("sla.breached")
                            : t("sla.dueIn", { minutes: Math.ceil(remaining / 60000) });
                        })()}
                      </td>
                      <td className="team-cell">
                        {ticket.departmentName}
                        <span className="table-caption">
                          {ticket.assignedToName || t("unassigned")}
                        </span>
                      </td>
                      <td className="date-cell">
                        <time dateTime={ticket.updatedAt} title={date(ticket.updatedAt, true)}>
                          {date(ticket.updatedAt)}
                        </time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              {t("matching", { count: records.length })}
              {cursor && (
                <button className="text-button" onClick={() => update("cursor", "")}>
                  {t("firstPage")}
                </button>
              )}
              {tickets.data?.nextCursor && (
                <button
                  className="text-button"
                  onClick={() => update("cursor", tickets.data!.nextCursor!)}
                >
                  {t("nextPage")}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
