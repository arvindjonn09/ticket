import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MailDnsRecords, MailProfileForm } from "./mail-profile";

it("starts a new write-only SMTP draft with encrypted connection choices", () => {
  const html = renderToStaticMarkup(<MailProfileForm save={async () => true} busy={false} />);
  expect(html).toContain('type="password"');
  expect(html).toContain('autoComplete="new-password"');
  expect(html).toContain('value="starttls"');
  expect(html).toContain('value="tls"');
  expect(html).not.toContain('value="none"');
  expect(html).toContain("Amazon SES");
  expect(html).toContain("Postmark");
  expect(html).toContain("Mailgun");
  expect(html).toContain("Self-hosted (mox)");
});

it("shows copyable DNS values and explicit success/failure text", () => {
  const html = renderToStaticMarkup(
    <MailDnsRecords
      records={[
        {
          type: "TXT",
          name: "example.test",
          expected: "v=spf1 -all",
          actual: ["v=spf1 -all"],
          ok: true,
        },
        {
          type: "MX",
          name: "in.example.test",
          expected: "10 mx.example.test",
          actual: [],
          ok: false,
        },
      ]}
    />,
  );
  expect(html).toContain("✓ Pass");
  expect(html).toContain("✗ Needs attention");
  expect(html).toContain("10 mx.example.test");
  expect(html).toContain("Copy value: in.example.test");
});
