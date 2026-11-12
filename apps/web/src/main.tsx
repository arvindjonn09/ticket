import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useOutletContext,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  CirclePlus,
  Inbox,
  LifeBuoy,
  LockKeyhole,
  LogOut,
  MessageSquare,
  Monitor,
  Moon,
  Search,
  Sun,
  Ticket,
  X,
} from "lucide-react";
import "./i18n";
import "./styles.css";
import { api, ApiError } from "./api";
import { updateSession } from "./session";
import { configureDates, displayDate } from "./dates";
import { AuthenticatorSetup, OrganisationSetup } from "./organisation";
import {
  NewRequest,
  Approvals,
  Reports,
  RequestInformation,
  TicketHistory,
  ChannelField,
} from "./completion";
import { Activation, Profile } from "./people";
import { Recovery } from "./recovery";
import { TicketManagement, Attachments, ReviseRequest } from "./ticket-tools";
import type { Catalog, SessionView, TicketDetail, TicketSummary } from "./types";

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
const states = [
  "Open",
  "In Progress",
  "On Hold",
  "Resolved",
  "Complete",
  "Cancelled",
  "Pending Approval",
  "Rejected",
] as const;
type Theme = "system" | "light" | "dark";
function ThemePicker() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem("astrama-theme");
      return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem("astrama-theme", theme);
    } catch {
      /* Browser storage may be unavailable. */
    }
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return (
    <div className="theme-picker" role="group" aria-label={t("theme")}>
      {(["light", "dark", "system"] as const).map((mode, index) => {
        const Icon = [Sun, Moon, Monitor][index]!;
        return (
          <button
            key={mode}
            type="button"
            aria-label={t(mode)}
            title={t(mode)}
            aria-pressed={theme === mode}
            onClick={() => setTheme(mode)}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
function Failure({ error, retry }: { error: Error; retry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="error" role="alert">
      <strong>
        {error instanceof ApiError && error.status === 409
          ? t("conflict")
          : error.message || t("error")}
      </strong>
      {retry && (
        <button className="text-button" type="button" onClick={retry}>
          {error instanceof ApiError && error.status === 409 ? t("reload") : t("retry")}
        </button>
      )}
    </div>
  );
}
function Loading() {
  const { t } = useTranslation();
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      {t("loading")}
    </div>
  );
}
function Status({ state }: { state: TicketSummary["state"] }) {
  const { t } = useTranslation();
  return (
    <span className={`status state-${state.toLowerCase().replaceAll(" ", "-")}`}>
      <span />
      {t(`states.${state}`)}
    </span>
  );
}
function date(value: string, full = false) {
  return displayDate(value, full);
}
function initials(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
function useSession() {
  return useOutletContext<SessionView>();
}

function Login() {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const login = useMutation({
    mutationFn: (body: {
      organisation: string;
      email: string;
      password: string;
      totpCode?: string;
    }) =>
      api<SessionView>("/auth/login", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (session) => {
      return updateSession(cache, session);
    },
  });
  return (
    <div className="login-page">
      <section className="login-story">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <LifeBuoy size={23} />
          </span>
          <span>
            Astrama<span className="brand-caption">{t("serviceDesk")}</span>
          </span>
        </Link>
        <div className="story-copy">
          <span className="eyebrow">{t("loginEyebrow")}</span>
          <h1>{t("welcome")}</h1>
          <p>{t("loginIntro")}</p>
          <div className="story-art" aria-hidden="true">
            <span className="art-line" />
            <span className="art-dot one" />
            <span className="art-dot two" />
            <span className="art-dot three" />
            <div className="art-ticket">
              <Ticket size={26} />
              <span />
              <span />
            </div>
            <div className="art-check">
              <Check size={27} />
            </div>
          </div>
          <span className="story-foot">{t("loginDetail")}</span>
        </div>
        <span className="login-copyright">{t("connected")}</span>
      </section>
      <section className="login-form-side">
        <div className="login-theme">
          <ThemePicker />
        </div>
        <div className="login-form-wrap">
          <span className="form-icon">
            <LockKeyhole size={22} />
          </span>
          <h2>{t("loginTitle")}</h2>
          <p className="muted">{t("loginSubtitle")}</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              login.mutate({
                organisation: String(form.get("organisation")).trim(),
                email: String(form.get("email")).trim(),
                password: String(form.get("password")),
                ...(form.get("totpCode") ? { totpCode: String(form.get("totpCode")) } : {}),
              });
            }}
          >
            <label>
              {t("organisation")}
              <input
                name="organisation"
                autoComplete="organization"
                placeholder={t("organisationPlaceholder")}
                required
                maxLength={100}
              />
            </label>
            <label>
              {t("email")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                placeholder={t("emailPlaceholder")}
                required
              />
            </label>
            <label>
              {t("password")}
              <input name="password" type="password" autoComplete="current-password" required />
            </label>
            <label>
              {t("authenticatorCodeOptional")}
              <input
                name="totpCode"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                minLength={6}
                maxLength={6}
              />
            </label>
            {login.error && <Failure error={login.error} />}
            <button className="button primary full" disabled={login.isPending}>
              {login.isPending ? t("signingIn") : t("signIn")}
              <ArrowRight size={17} />
            </button>
          </form>
          <p>
            <a href="/forgot-password">{t("forgotPassword")}</a>
          </p>
          <p className="login-privacy">
            <LockKeyhole size={13} />
            {t("loginFoot")}
          </p>
          {import.meta.env.DEV && (
            <details className="demo-help">
              <summary>{t("demoTitle")}</summary>
              <p>{t("demoOrgs")}</p>
              <p>{t("demoUsers")}</p>
              <p>{t("demoPassword")}</p>
            </details>
          )}
        </div>
      </section>
    </div>
  );
}
function Shell({ session }: { session: SessionView }) {
  const { t } = useTranslation();
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const brandColour = /^#[0-9a-f]{6}$/i.test(session.tenant.primaryColour || "")
    ? session.tenant.primaryColour
    : undefined;
  const luminance = brandColour
    ? [1, 3, 5]
        .map((index) => parseInt(brandColour.slice(index, index + 2), 16) / 255)
        .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
    : 0;
  useEffect(() => {
    document.title = `${session.tenant.brandName} · ${t("serviceDesk")}`;
  }, [session.tenant.brandName, t]);
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST", body: "{}" }, session.csrfToken),
    onSuccess: () => {
      return updateSession(cache, null);
    },
  });
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        {t("overview")}
      </a>
      <aside className="sidebar">
        <Link
          className="brand"
          to={
            session.user.role === "admin"
              ? session.mfaVerified
                ? "/organisation"
                : "/authenticator"
              : "/tickets"
          }
        >
          <span
            className="brand-mark"
            style={
              brandColour
                ? { background: brandColour, color: luminance > 0.179 ? "#000000" : "#ffffff" }
                : undefined
            }
          >
            <LifeBuoy size={23} />
          </span>
          <span>
            {session.tenant.brandName}
            <span className="brand-caption">{t("serviceDesk")}</span>
          </span>
        </Link>
        <div className="workspace-label">{t("workspace")}</div>
        <nav aria-label={t("workspace")}>
          {(session.user.role !== "admin" || session.mfaVerified) && (
            <>
              <NavLink
                to="/tickets"
                end
                className={({ isActive }) =>
                  isActive && !params.get("scope") ? "nav-link active" : "nav-link"
                }
              >
                <Inbox size={18} />
                {t(session.user.role === "agent" ? "allTickets" : "myTickets")}
              </NavLink>
              {session.user.role === "agent" && (
                <Link
                  to="/tickets?scope=mine"
                  className={params.get("scope") === "mine" ? "nav-link active" : "nav-link"}
                >
                  <Ticket size={18} />
                  {t("myTickets")}
                </Link>
              )}
              <NavLink to="/requests/new" className="nav-link">
                <CirclePlus size={18} />
                {t("newRequest")}
              </NavLink>
              <NavLink to="/approvals" className="nav-link">
                <Check size={18} />
                {t("myApprovals")}
              </NavLink>
              <NavLink to="/profile" className="nav-link">
                <Ticket size={18} />
                {t("profile")}
              </NavLink>
              {session.user.role !== "employee" && (
                <NavLink to="/reports" className="nav-link">
                  <Inbox size={18} />
                  {t("reports")}
                </NavLink>
              )}
              <NavLink to="/tickets/new" className="nav-link">
                <CirclePlus size={18} />
                {t("newIncident")}
              </NavLink>
            </>
          )}
          {session.user.role === "admin" && (
            <NavLink
              to={session.mfaVerified ? "/organisation" : "/authenticator"}
              className="nav-link"
            >
              <LockKeyhole size={18} />
              {t(session.mfaVerified ? "organisationSetup" : "mfaTitle")}
            </NavLink>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="tenant-label">
            <span className="tenant-dot" />
            {session.tenant.name}
          </div>
          <div className="user-block">
            <span className="avatar">{initials(session.user.name)}</span>
            <div>
              <strong>{session.user.name}</strong>
              <span>
                {t(
                  session.user.role === "admin"
                    ? "administrator"
                    : session.user.role === "agent"
                      ? "support"
                      : "employee",
                )}
              </span>
            </div>
            <button
              type="button"
              className="icon-button"
              aria-label={t("signOut")}
              title={t("signOut")}
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
            >
              <LogOut size={17} />
            </button>
          </div>
          {logout.error && <Failure error={logout.error} />}
          <ThemePicker />
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <span>
            {t(
              session.user.role === "admin"
                ? "administrator"
                : session.user.role === "agent"
                  ? "support"
                  : "employee",
            )}
          </span>
          <span className="organisation-name">{session.tenant.name}</span>
        </header>
        <main id="main-content">
          <Outlet context={session} />
        </main>
        <footer className="page-footer">
          <span>{session.tenant.brandName}</span>
          <span>{t("serviceDesk")}</span>
        </footer>
      </div>
    </div>
  );
}
function TicketList() {
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
  }).toString();
  const tickets = useQuery({
    queryKey: ["tickets", queryString],
    queryFn: () => api<{ tickets: TicketSummary[] }>(`/tickets?${queryString}`),
  });
  const records = tickets.data?.tickets || [];
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
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
              {records.length >= 200 && <span>{t("resultsLimit")}</span>}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
function NewIncident() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const callers = useQuery({
    queryKey: ["request-catalog"],
    queryFn: () => api<{ users: { id: string; name: string }[] }>("/requests/catalog"),
    enabled: session.user.role === "agent",
  });
  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => api<Catalog>("/catalog"),
  });
  const availableCategories =
    catalog.data?.categories.filter((category) => category.allowIncidents !== false) || [];
  const idempotencyKey = useRef(crypto.randomUUID());
  const create = useMutation({
    mutationFn: (body: {
      categoryId: string;
      subcategoryId?: string;
      summary: string;
      description: string;
      callerId?: string;
      channel: string;
    }) =>
      api<TicketDetail>(
        "/tickets",
        {
          method: "POST",
          headers: { "Idempotency-Key": idempotencyKey.current },
          body: JSON.stringify(body),
        },
        session.csrfToken,
      ),
    onSuccess: (ticket) => {
      void cache.invalidateQueries({ queryKey: ["tickets"] });
      cache.setQueryData(["ticket", ticket.id], ticket);
      navigate(`/tickets/${ticket.id}`);
    },
  });
  return (
    <div className="page narrow-page">
      <Link className="back-link" to="/tickets">
        <ArrowLeft size={15} />
        {t("back")}
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">{t("new")}</div>
          <h1>{t("createTitle")}</h1>
          <p>{t("createIntro")}</p>
        </div>
      </div>
      <div className="create-grid">
        <section className="form-panel">
          {catalog.isPending ? (
            <Loading />
          ) : catalog.error ? (
            <Failure
              error={catalog.error}
              retry={() => {
                void catalog.refetch();
              }}
            />
          ) : (
            <form
              onChange={() => {
                idempotencyKey.current = crypto.randomUUID();
              }}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                create.mutate({
                  categoryId,
                  ...(subcategoryId ? { subcategoryId } : {}),
                  summary: String(form.get("summary")).trim(),
                  description: String(form.get("description")).trim(),
                  channel:
                    session.user.role === "agent" ? String(form.get("channel")) : "Self Service",
                  ...(session.user.role === "agent"
                    ? { callerId: String(form.get("callerId")) }
                    : {}),
                });
              }}
            >
              {session.user.role === "agent" && (
                <>
                  <label>
                    {t("caller")}
                    <select name="callerId" required defaultValue={session.user.id}>
                      <option value={session.user.id}>{session.user.name}</option>
                      {callers.data?.users
                        .filter((user) => user.id !== session.user.id)
                        .map((user) => (
                          <option key={user.id} value={user.id}>
                            {user.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  {callers.error && <Failure error={callers.error} />}
                  <ChannelField />
                </>
              )}
              <label>
                {t("category")}
                <select
                  required
                  value={categoryId}
                  onChange={(event) => {
                    setCategoryId(event.target.value);
                    setSubcategoryId("");
                    idempotencyKey.current = crypto.randomUUID();
                  }}
                >
                  <option value="">{t("chooseCategory")}</option>
                  {availableCategories.map((category) => (
                    <option value={category.id} key={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              {categoryId && (
                <>
                  <label>
                    {t("subcategory")}
                    <select
                      value={subcategoryId}
                      onChange={(event) => {
                        setSubcategoryId(event.target.value);
                        idempotencyKey.current = crypto.randomUUID();
                      }}
                    >
                      <option value="">{t("noSubcategory")}</option>
                      {availableCategories
                        .find((category) => category.id === categoryId)
                        ?.subcategories.map((subcategory) => (
                          <option key={subcategory.id} value={subcategory.id}>
                            {subcategory.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="field-hint routing-preview" role="status">
                    {t("routedTo", {
                      team:
                        availableCategories
                          .find((category) => category.id === categoryId)
                          ?.subcategories.find((subcategory) => subcategory.id === subcategoryId)
                          ?.departmentName ||
                        availableCategories.find((category) => category.id === categoryId)
                          ?.departmentName,
                    })}
                  </p>
                </>
              )}
              {availableCategories.length === 0 && <p className="error">{t("noCategories")}</p>}
              <label>
                {t("summary")}
                <input
                  name="summary"
                  required
                  minLength={5}
                  maxLength={160}
                  placeholder={t("summaryPlaceholder")}
                  aria-describedby="summary-hint"
                  onChange={() => {
                    idempotencyKey.current = crypto.randomUUID();
                  }}
                />
                <span id="summary-hint" className="field-hint">
                  {t("summaryHint")}
                </span>
              </label>
              <label>
                {t("description")}
                <textarea
                  name="description"
                  required
                  minLength={10}
                  maxLength={5000}
                  rows={7}
                  placeholder={t("descriptionPlaceholder")}
                  aria-describedby="description-hint"
                  onChange={() => {
                    idempotencyKey.current = crypto.randomUUID();
                  }}
                />
                <span id="description-hint" className="field-hint">
                  {t("descriptionHint")}
                </span>
              </label>
              {create.error && <Failure error={create.error} />}
              <div className="form-actions">
                <Link className="button secondary" to="/tickets">
                  {t("cancel")}
                </Link>
                <button
                  className="button primary"
                  disabled={create.isPending || !availableCategories.length}
                >
                  {t(create.isPending ? "submitting" : "submit")}
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          )}
        </section>
        <aside className="help-panel">
          <CircleHelp size={22} />
          <h2>{t("requestInfo")}</h2>
          <ol>
            {["requestStepOne", "requestStepTwo", "requestStepThree"].map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
function IncidentDetail() {
  const { t } = useTranslation();
  const session = useSession();
  const { id } = useParams();
  const cache = useQueryClient();
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<"customer" | "internal">("customer");
  const [resolving, setResolving] = useState(false);
  const [resolution, setResolution] = useState("");
  const [customerSummary, setCustomerSummary] = useState("");
  const detail = useQuery({
    queryKey: ["ticket", id],
    queryFn: () => api<TicketDetail>(`/tickets/${encodeURIComponent(id!)}`),
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
      if (variables.action === "messages")
        setBody((current) => (current.trim() === variables.data.body ? "" : current));
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
    session.user.role === "agent" && session.user.departmentIds.includes(ticket.departmentId);
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
        <div className="detail-byline">
          {t("reportedBy")}{" "}
          <Link to={`/users/${ticket.callerId}`}>
            <strong>{ticket.callerName}</strong>
          </Link>
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
            {canMessage && (
              <form
                className={`composer ${audience === "internal" ? "internal-composer" : ""}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  mutation.mutate({
                    action: "messages",
                    data: { body: body.trim(), audience },
                  });
                }}
              >
                <div className="composer-tabs">
                  {(["customer", ...(isAgent ? (["internal"] as const) : [])] as const).map(
                    (value) => (
                      <button
                        key={value}
                        type="button"
                        className={audience === value ? "selected" : ""}
                        aria-pressed={audience === value}
                        disabled={mutation.isPending}
                        onClick={() => setAudience(value)}
                      >
                        {value === "internal" ? (
                          <LockKeyhole size={14} />
                        ) : (
                          <MessageSquare size={14} />
                        )}{" "}
                        {t(value === "internal" ? "internalNote" : "customerMessage")}
                      </button>
                    ),
                  )}
                </div>
                <label className="sr-only" htmlFor="message">
                  {t("message")}
                </label>
                <textarea
                  id="message"
                  disabled={mutation.isPending}
                  required
                  maxLength={5000}
                  rows={4}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder={t(
                    audience === "internal" ? "notePlaceholder" : "messagePlaceholder",
                  )}
                />
                <div className="composer-footer">
                  <span>{t(audience === "internal" ? "internalHint" : "publicHint")}</span>
                  <button className="button primary" disabled={mutation.isPending || !body.trim()}>
                    {t(
                      mutation.isPending ? "sending" : audience === "internal" ? "addNote" : "send",
                    )}
                    <ArrowRight size={14} />
                  </button>
                </div>
              </form>
            )}
            {closed && (
              <div className="closed-message">
                <Check size={16} />
                {t("closed")}
              </div>
            )}
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
        <aside className="details-sidebar">
          <h2>{t("classification")}</h2>
          <dl>
            <dt>{t("channel")}</dt>
            <dd>{t(`channels.${ticket.channel}`)}</dd>
            {ticket.duplicateOfId && (
              <>
                <dt>{t("duplicateOf")}</dt>
                <dd>
                  <Link className="ticket-number" to={`/tickets/${ticket.duplicateOfId}`}>
                    {t("viewOriginalTicket")}
                  </Link>
                </dd>
              </>
            )}
            <dt>{t("status")}</dt>
            <dd>
              <Status state={ticket.state} />
            </dd>
            <dt>{t("priority")}</dt>
            <dd>{ticket.priority}</dd>
            <dt>{t("category")}</dt>
            <dd>{ticket.categoryName}</dd>
            <dt>{t("subcategory")}</dt>
            <dd>{ticket.subcategoryName || t("noSubcategory")}</dd>
            <dt>{t("team")}</dt>
            <dd>{ticket.departmentName}</dd>
            <dt>{t("assignedTo")}</dt>
            <dd>{ticket.assignedToName || t("unassigned")}</dd>
            <dt>{t("updated")}</dt>
            <dd>{date(ticket.updatedAt, true)}</dd>
          </dl>
          <TicketManagement
            session={session}
            ticket={ticket}
            isAgent={isAgent}
            isRequester={isRequester}
            closed={closed}
            onSaved={(updated) => {
              cache.setQueryData(["ticket", id], updated);
              void cache.invalidateQueries({ queryKey: ["tickets"] });
              void cache.invalidateQueries({
                queryKey: ["ticket-history", id],
              });
            }}
          />
          {isAgent && !closed && (
            <div className="ticket-actions">
              {!ticket.assignedToId && (
                <button
                  className="button secondary full"
                  disabled={mutation.isPending}
                  onClick={() => mutation.mutate({ action: "claim", data: {} })}
                >
                  {t("claim")}
                </button>
              )}
              {ticket.state === "Open" && (
                <button
                  className="button primary full"
                  disabled={mutation.isPending}
                  onClick={() => stateChange("In Progress")}
                >
                  {t("startWork")}
                  <ArrowRight size={15} />
                </button>
              )}
              {ticket.state === "In Progress" && (
                <button
                  className="button primary full"
                  disabled={mutation.isPending}
                  onClick={() => setResolving(true)}
                >
                  {t(ticket.type === "request" ? "fulfilRequest" : "resolve")}
                  <Check size={16} />
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
function App() {
  const [resetting] = useState(() => location.hash.startsWith("#reset-password?"));
  const [activating] = useState(
    () => location.pathname === "/activate" || location.hash.startsWith("#activate?"),
  );
  const session = useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      try {
        return await api<SessionView>("/auth/session");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
  if (resetting) return <Recovery mode="reset" />;
  if (location.pathname === "/forgot-password") return <Recovery mode="forgot" />;
  if (activating) return <Activation />;
  if (session.isPending) return <Loading />;
  if (session.error)
    return (
      <div className="startup-error">
        <Failure
          error={session.error}
          retry={() => {
            void session.refetch();
          }}
        />
      </div>
    );
  if (!session.data) return <Login />;
  configureDates(session.data.tenant);
  return (
    <Routes>
      <Route element={<Shell session={session.data} />}>
        {session.data.user.role === "admin" && !session.data.mfaVerified ? (
          <>
            <Route path="/authenticator" element={<AuthenticatorSetup session={session.data} />} />
            <Route path="*" element={<Navigate to="/authenticator" replace />} />
          </>
        ) : (
          <>
            <Route path="/tickets" element={<TicketList />} />
            <Route path="/tickets/new" element={<NewIncident />} />
            <Route path="/requests/new" element={<NewRequest session={session.data} />} />
            <Route path="/approvals" element={<Approvals session={session.data} />} />
            <Route path="/profile" element={<Profile session={session.data} />} />
            <Route path="/users/:id" element={<Profile session={session.data} />} />
            {session.data.user.role !== "employee" && (
              <Route path="/reports" element={<Reports session={session.data} />} />
            )}
            <Route path="/tickets/:id" element={<IncidentDetail />} />
            {session.data.user.role === "admin" && (
              <Route path="/organisation" element={<OrganisationSetup session={session.data} />} />
            )}
            <Route
              path="*"
              element={
                <Navigate
                  to={session.data.user.role === "admin" ? "/organisation" : "/tickets"}
                  replace
                />
              }
            />
          </>
        )}
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
