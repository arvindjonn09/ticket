import { describe, expect, it } from "vitest";
import { collapseQuotedHistory } from "./inbound-mail.service.js";

describe("collapseQuotedHistory", () => {
  it.each([
    [
      "Outlook desktop",
      "My reply\r\n________________________________\r\nFrom: Alex Example <alex@example.test>\r\nSent: Monday, 16 November 2026 9:00 AM\r\nEarlier message",
    ],
    [
      "Outlook web",
      "My reply\nFrom: Alex Example <alex@example.test>\r\nSent: Monday, 16 November 2026 9:00 AM\r\nEarlier message",
    ],
    ["Gmail", "My reply\n\nOn Mon, Nov 16, 2026 at 9:00 AM Alex Example wrote:\nEarlier message"],
  ])("removes %s quoted history", (_client, text) => {
    expect(collapseQuotedHistory(text)).toBe("My reply");
  });

  it("preserves plaintext paragraphs without quoted history", () => {
    const text = "Please help with this.\n\nThis is a second paragraph.";
    expect(collapseQuotedHistory(text)).toBe(text);
  });

  it("removes quoted lines and a standard signature", () => {
    expect(
      collapseQuotedHistory("My reply\n\n-- \nAlex\nSupport\n\n> Prior question\n> Prior context"),
    ).toBe("My reply");
  });
});
