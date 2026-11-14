import { describe, expect, it } from "vitest";
import {
  isLoopMessage,
  notificationDeliveryId,
  recipientAddress,
  replyTokenHash,
  TestInboundAdapter,
  validWebhookSignature,
  webhookSignature,
} from "./inbound-mail.adapter.js";

const message = {
  messageId: "<mail-1@sender.example>",
  recipient: "help+t.fake@example.test",
  sender: "requester@example.test",
  authResults: { spf: "pass", dkim: "pass", dmarc: "pass" },
};

describe("test inbound mail adapter", () => {
  it("normalizes signatures and rejects stale or altered webhooks", () => {
    const input = TestInboundAdapter.normalize(message);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = webhookSignature(timestamp, input, "test-secret");
    expect(validWebhookSignature(timestamp, input, signature, "test-secret")).toBe(true);
    expect(
      validWebhookSignature(timestamp, { ...input, subject: "altered" }, signature, "test-secret"),
    ).toBe(false);
    expect(validWebhookSignature("1", input, signature, "test-secret")).toBe(false);
  });

  it("removes a reply token before resolving a tenant address and stores only its hash", () => {
    const parsed = recipientAddress("help+t." + "a".repeat(64) + "@example.test");
    expect(parsed.address).toBe("help@example.test");
    expect(parsed.token).toBe("a".repeat(64));
    expect(replyTokenHash(parsed.token!)).not.toBe(parsed.token);
  });

  it("filters automatic messages and correlates only delivery UUIDs", () => {
    const input = TestInboundAdapter.normalize({
      ...message,
      headers: { autoSubmitted: "auto-replied" },
    });
    expect(isLoopMessage(input, [], "example.test")).toBe(true);
    expect(notificationDeliveryId("<49ed0e4f-2c8b-4b77-a92a-426f4352f596@example.test>")).toBe(
      "49ed0e4f-2c8b-4b77-a92a-426f4352f596",
    );
    expect(notificationDeliveryId("<untrusted@example.test>")).toBeNull();
  });
});
