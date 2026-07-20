import { describe, expect, it } from "vitest";
import { buildDeliveryStatus, summarizeMessageToolSends } from "./delivery-status.js";

describe("buildDeliveryStatus", () => {
  it("flags missing receipt when visible delivery is required but only private final text exists", () => {
    const status = buildDeliveryStatus({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      observedReplyDelivery: false,
      queuedFinal: false,
      finalPayloadCount: 1,
      privateFinalTextPresent: true,
      messageToolSends: { attempted: 0, completed: 0 },
      silentExpected: false,
      allowEmptyAssistantReplyAsSilent: false,
    });

    expect(status).toEqual({
      source_delivery_mode: "message_tool_only",
      visible_delivery_required: true,
      message_tool_sends: { attempted: 0, completed: 0 },
      final_reply_visibility: "private_suppressed",
      completion_receipt: "missing",
      delivery_suppression_reason: "sourceReplyDeliveryMode: message_tool_only",
      missing_receipt: true,
    });
  });

  it("treats a completed message-tool send as the visible completion receipt", () => {
    const status = buildDeliveryStatus({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      observedReplyDelivery: true,
      queuedFinal: false,
      finalPayloadCount: 0,
      privateFinalTextPresent: false,
      messageToolSends: { attempted: 1, completed: 1 },
      silentExpected: false,
      allowEmptyAssistantReplyAsSilent: false,
    });

    expect(status.final_reply_visibility).toBe("message_tool_visible");
    expect(status.completion_receipt).toBe("message_tool_receipt");
    expect(status.missing_receipt).toBe(false);
  });

  it("does not flag explicitly quiet delivery:none-style runs", () => {
    const status = buildDeliveryStatus({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      observedReplyDelivery: false,
      queuedFinal: false,
      finalPayloadCount: 0,
      privateFinalTextPresent: false,
      messageToolSends: { attempted: 0, completed: 0 },
      silentExpected: true,
      allowEmptyAssistantReplyAsSilent: true,
    });

    expect(status.visible_delivery_required).toBe(false);
    expect(status.final_reply_visibility).toBe("intentional_silence");
    expect(status.completion_receipt).toBe("not_required");
    expect(status.missing_receipt).toBe(false);
  });

  it("summarizes only message send actions as delivery attempts", () => {
    const summary = summarizeMessageToolSends({
      toolCallIds: ["send-1", "read-1", "send-2"],
      completedToolCallIds: ["send-1"],
    });

    expect(summary).toEqual({ attempted: 3, completed: 1 });
  });
});
