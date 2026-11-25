import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import "./i18n";
import { PoweredByAstrama } from "./branding";
import { Login } from "./workspaces/support/login";
import { Shell } from "./workspaces/support/shell";
import type { SessionView } from "./types";

function render(element: ReactElement) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe.each(["login", "employee", "agent", "admin"] as const)("%s branding", (page) => {
  it.each([undefined, false, true])("hides the footer only for hideBranding=%s", (hideBranding) => {
    const session: SessionView = {
      user: {
        id: "user",
        name: "Demo User",
        email: "user@demo.test",
        role: page === "login" ? "employee" : page,
        departmentIds: [],
      },
      tenant: { id: "tenant", name: "Demo", slug: "demo", brandName: "Demo", hideBranding },
      csrfToken: "csrf",
    };
    const html = render(
      page === "login" ? <Login hideBranding={hideBranding} /> : <Shell session={session} />,
    );
    expect(html.includes("Powered by Astrama")).toBe(hideBranding !== true);
  });
});

it("links to the configured public site and uses plain text when no URL is configured", () => {
  expect(render(<PoweredByAstrama brandingUrl="https://astrama.test/?ref=demo" />)).toContain(
    '<a href="https://astrama.test/?ref=demo">Powered by Astrama</a>',
  );
  expect(render(<PoweredByAstrama />)).not.toContain("<a");
  expect(
    render(<PoweredByAstrama hideBranding brandingUrl="https://astrama.test/?ref=demo" />),
  ).toBe("");
});
