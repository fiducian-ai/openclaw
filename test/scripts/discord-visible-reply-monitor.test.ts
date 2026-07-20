import { describe, expect, it } from "vitest";
import { detectVisibleReplyGaps } from "../../scripts/dev/discord-visible-reply-monitor.mjs";

const DISCORD_EPOCH = 1420070400000n;
function snowflakeAt(ms: number): string {
  return String((BigInt(ms) - DISCORD_EPOCH) << 22n);
}

describe("discord-visible-reply-monitor", () => {
  it("flags a human prompt with no visible agent reply inside the window", () => {
    const base = Date.parse("2026-07-20T02:00:00.000Z");
    const gaps = detectVisibleReplyGaps(
      [
        {
          id: snowflakeAt(base),
          content: "costaff can you check this?",
          author: { id: "spencer", bot: false },
        },
      ],
      {
        channelId: "1468361476585558210",
        botAuthorIds: ["agent"],
        replyWindowMinutes: 5,
        now: base + 10 * 60_000,
      },
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        channelId: "1468361476585558210",
        promptMessageId: snowflakeAt(base),
        promptAuthorId: "spencer",
      }),
    ]);
  });

  it("does not count unrelated bot messages as visible agent replies", () => {
    const base = Date.parse("2026-07-20T02:00:00.000Z");
    const gaps = detectVisibleReplyGaps(
      [
        {
          id: snowflakeAt(base),
          content: "costaff are you there?",
          author: { id: "spencer", bot: false },
        },
        {
          id: snowflakeAt(base + 60_000),
          content: "build notification",
          author: { id: "github-bot", bot: true },
        },
      ],
      {
        channelId: "1468361476585558210",
        botAuthorIds: ["agent"],
        humanAuthorIds: ["spencer"],
        replyWindowMinutes: 5,
        now: base + 10 * 60_000,
      },
    );

    expect(gaps).toEqual([
      expect.objectContaining({
        promptMessageId: snowflakeAt(base),
        promptAuthorId: "spencer",
      }),
    ]);
  });

  it("does not rely on diagnostic completion and clears when a visible agent message follows", () => {
    const base = Date.parse("2026-07-20T02:00:00.000Z");
    const gaps = detectVisibleReplyGaps(
      [
        {
          id: snowflakeAt(base),
          content: "please run a tool-heavy check",
          author: { id: "spencer", bot: false },
        },
        {
          id: snowflakeAt(base + 60_000),
          content: "[diagnostic] message processed: outcome=completed",
          author: { id: "logger", bot: false },
        },
        {
          id: snowflakeAt(base + 2 * 60_000),
          content: "visible reply observed",
          author: { id: "agent", bot: true },
        },
      ],
      {
        channelId: "1468361476585558210",
        botAuthorIds: ["agent"],
        humanAuthorIds: ["spencer"],
        replyWindowMinutes: 5,
        now: base + 10 * 60_000,
      },
    );

    expect(gaps).toEqual([]);
  });
});
