import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import "./i18n";
import "./styles.css";
import { api, ApiError } from "./api";
import { configureDates } from "./dates";
import { AuthenticatorSetup, OrganisationSetup } from "./workspaces/admin/organisation";
import { NewRequest, Approvals, Reports } from "./workspaces/approver/completion";
import { Activation, Profile } from "./workspaces/employee/people";
import { Recovery } from "./recovery";
import { Billing, Signup } from "./billing";
import type { SessionView } from "./types";
import {
  Failure,
  Loading,
  Login,
  Shell,
  TicketList,
  NewIncident,
  IncidentDetail,
} from "./workspaces/support/pages";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});
function App() {
  const { t } = useTranslation();
  const [resetting] = useState(() => location.hash.startsWith("#reset-password?"));
  const [activating] = useState(
    () => location.pathname === "/activate" || location.hash.startsWith("#activate?"),
  );
  const session = useQuery({
    queryKey: ["session"],
    enabled: false,
    queryFn: async () => {
      try {
        return await api<SessionView>("/auth/session");
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
  });
  const host = useQuery({
    queryKey: ["platform-host"],
    queryFn: async () => {
      try {
        return await api<{ mode: string; kind: string; tenantSlug?: string }>("/platform/host");
      } catch (error) {
        if (error instanceof ApiError && error.status === 404)
          return { mode: "hosted", kind: "unknown" };
        throw error;
      }
    },
  });
  React.useEffect(() => {
    if (host.data?.kind === "tenant" || host.data?.kind === "single") void session.refetch();
  }, [host.data?.kind]);
  if (host.isPending) return <Loading />;
  if (host.error)
    return (
      <div className="startup-error">
        <Failure error={host.error} retry={() => void host.refetch()} />
      </div>
    );
  if (host.data?.kind === "unknown")
    return (
      <main className="startup-error" role="main">
        <h1>{t("organisationNotFound")}</h1>
        <p>{t("organisationNotFoundHint")}</p>
      </main>
    );
  if (host.data?.kind === "public" || host.data?.kind === "operator")
    if (host.data.kind === "public" && location.pathname.startsWith("/signup")) return <Signup />;
  if (host.data?.kind === "public" || host.data?.kind === "operator")
    return (
      <main className="startup-error" role="main">
        <h1>{t("platformNotAvailable")}</h1>
      </main>
    );
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
  if (!session.data)
    return (
      <Login {...(host.data?.kind === "tenant" ? { organisation: host.data.tenantSlug } : {})} />
    );
  configureDates(session.data.tenant);
  return (
    <Routes>
      <Route element={<Shell session={session.data} />}>
        {["admin", "agent"].includes(session.data.user.role) && !session.data.mfaVerified ? (
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
              <>
                <Route
                  path="/organisation"
                  element={<OrganisationSetup session={session.data} />}
                />
                <Route path="/billing" element={<Billing session={session.data} />} />
              </>
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
