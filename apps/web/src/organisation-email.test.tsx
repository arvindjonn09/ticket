import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { OrganisationEmail } from "./organisation-email";
import type { SessionView } from "./types";

it("guides tenant receiving and default sending with a safe delivery test", () => {
  const session: SessionView = {
    user: {
      id: "user",
      name: "Admin",
      email: "admin@example.test",
      role: "admin",
      departmentIds: [],
    },
    tenant: { id: "tenant", name: "Demo", brandName: "Demo", slug: "demo" },
    csrfToken: "csrf",
  };
  const cache = new QueryClient();
  cache.setQueryData(["outgoing-email", session.tenant.id], {
    revision: 0,
    mode: "platform",
    effectiveMode: "platform",
    status: "working",
    smtp: null,
    lastError: null,
    testedAt: null,
    microsoft365Available: false,
    pendingMicrosoft365: null,
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <OrganisationEmail session={session} />
    </QueryClientProvider>,
  );
  expect(html).toContain("1. Receive email as tickets");
  expect(html).toContain("2. Send email to your users");
  expect(html).toContain("Astrama default");
  expect(html).toContain("Test delivery to my email");
  expect(html).not.toContain('type="password"');
});
