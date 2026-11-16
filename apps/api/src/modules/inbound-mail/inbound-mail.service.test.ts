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
});
