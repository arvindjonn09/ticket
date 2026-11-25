import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { OutgoingMailView } from "@astrama/contracts";
import type { SessionView } from "./types";
import { OutgoingMailPanel, microsoftSignInUrl } from "./outgoing-mail";
import { OutgoingSmtpForm } from "./outgoing-mail-forms";

const session: SessionView = {
  user: {
    id: "admin",
    name: "Demo",
    email: "admin@example.test",
    role: "admin",
    departmentIds: [],
  },
  tenant: { id: "tenant", name: "Demo", slug: "demo", brandName: "Demo" },
  csrfToken: "csrf",
};
const platform: OutgoingMailView = {
  revision: 0,
  mode: "platform",
  effectiveMode: "platform",
  status: "working",
  smtp: null,
  lastError: null,
  testedAt: null,
  microsoft365Available: true,
  pendingMicrosoft365: null,
};
function render(view: OutgoingMailView) {
  const cache = new QueryClient();
  cache.setQueryData(["outgoing-email", session.tenant.id], view);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <OutgoingMailPanel session={session} />
    </QueryClientProvider>,
  );
}

it("keeps Google SMTP credentials write-only and offers encrypted connections only", () => {
  const html = renderToStaticMarkup(
    <OutgoingSmtpForm
      settings={null}
      provider="google"
      revision={0}
      busy={false}
      save={async () => true}
    />,
  );
  expect(html).toContain('value="smtp.gmail.com"');
  expect(html).toContain('value="starttls"');
  expect(html).toContain('value="tls"');
  expect(html).not.toContain('value="none"');
  expect(html).toContain('type="password"');
  expect(html).toContain('autoComplete="new-password"');
  expect(html).toContain("2-Step Verification");
  expect(html).toContain("https://support.google.com/accounts/answer/185833");
});
it("shows the configured sender separately from automatic platform fallback", () => {
  const html = render({
    ...platform,
    mode: "smtp",
    effectiveMode: "platform",
    status: "problem",
    lastError: "Authentication failed",
  });
  expect(html).toContain("Configured sender");
  expect(html).toContain("Currently sending through");
  expect(html).toContain("Astrama default is currently sending your notifications");
  expect(html).toContain("Authentication failed");
});
it("requires a final test after Microsoft consent and allows abandoning pending setup", () => {
  const html = render({
    ...platform,
    pendingMicrosoft365: {
      connectionId: "00000000-0000-4000-8000-000000000001",
      status: "ready",
      mailboxAddress: "support@example.test",
      fromAddress: "support@example.test",
      error: null,
      expiresAt: "2026-11-25T08:00:00.000Z",
    },
  });
  expect(html).toContain("Microsoft consent received");
  expect(html).toContain("Send test and save");
  expect(html).not.toContain('type="password"');
});
it("displays server errors as text without interpreting markup", () => {
  const html = render({ ...platform, lastError: "<script>untrusted()</script>" });
  expect(html).toContain("&lt;script&gt;untrusted()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
});

it("leaves read-only forms disabled without announcing an in-progress test", () => {
  const html = renderToStaticMarkup(
    <OutgoingSmtpForm
      settings={null}
      provider="smtp"
      revision={0}
      busy={false}
      disabled
      save={async () => true}
    />,
  );
  expect(html).toContain('<fieldset disabled=""');
  expect(html).toContain("Send test and save");
  expect(html).not.toContain("Sending test…");
});

it("allows only the agreed HTTPS Microsoft authority for the consent redirect", () => {
  const valid =
    "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?state=fixture";
  expect(microsoftSignInUrl(valid)).toBe(valid);
  for (const invalid of [
    "javascript:alert(1)",
    "http://login.microsoftonline.com/",
    "https://login.microsoftonline.com.evil.test/",
    "https://login.microsoftonline.com:444/",
    "https://user:secret@login.microsoftonline.com/",
    "/relative",
  ]) {
    expect(microsoftSignInUrl(invalid)).toBeNull();
  }
});
