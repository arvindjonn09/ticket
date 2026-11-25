import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { InboundMailView } from "@astrama/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ForwardingGuide } from "./forwarding-guide";

const config: InboundMailView = {
  revision: 0,
  configured: true,
  secretConfigured: true,
  triageDepartmentId: null,
  triageCategoryId: null,
  allowUnverifiedSenders: false,
  addresses: [],
  departments: [],
  categories: [],
};

function render(value: InboundMailView) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ForwardingGuide config={value} csrfToken="csrf" />
    </QueryClientProvider>,
  );
}

it("supports older settings responses and disables checks without configured receiving", () => {
  const html = render(config);
  expect(html).toContain("Not set up");
  expect(html).toContain("An inbound address is not configured");
  expect(html).toContain('disabled=""');
  expect(
    render({ ...config, configured: false, platformAddress: "demo@in.astrama.test" }),
  ).toContain('disabled=""');
});

it.each([
  ["not_set_up", "Not set up"],
  ["pending", "Pending"],
  ["working", "Working"],
  ["problem", "Problem"],
] as const)(
  "shows the server's %s forwarding status and provider instructions",
  (status, label) => {
    const html = render({
      ...config,
      platformAddress: "demo@in.astrama.test",
      forwarding: { status, lastReceivedAt: null, startedAt: null, verifiedAt: null },
    });
    expect(html).toContain(`<p role="status">${label}</p>`);
    expect(html).toContain('value="demo@in.astrama.test"');
    expect(html).toContain("outbound spam policy must allow automatic external forwarding");
    expect(html).toContain("Gmail → Routing");
    expect(html).not.toContain('disabled=""');
  },
);

it("lists active configured department aliases only", () => {
  const address = {
    id: "alias",
    address: "demo+it@in.astrama.test",
    departmentId: "department",
    categoryId: "category",
    isGeneral: false,
    active: true,
    revision: 0,
  };
  const html = render({
    ...config,
    addresses: [
      address,
      { ...address, id: "inactive", address: "old@in.astrama.test", active: false },
    ],
  });
  expect(html).toContain("demo+it@in.astrama.test");
  expect(html).not.toContain("old@in.astrama.test");
});
