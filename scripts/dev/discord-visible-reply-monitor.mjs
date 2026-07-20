#!/usr/bin/env node
/**
 * Warn-only Discord visible-reply monitor.
 *
 * Detects a human prompt in a channel followed by no configured agent/bot
 * message within a bounded window. This intentionally does not treat OpenClaw
 * diagnostic `outcome=completed` as delivery evidence; only a subsequent
 * visible Discord message from the configured bot/agent author ids counts as
 * delivered.
 */

const DEFAULT_CHANNEL_ID = "1468361476585558210"; // #fiducian-chat
const DEFAULT_LOOKBACK_MINUTES = 60;
const DEFAULT_REPLY_WINDOW_MINUTES = 5;
const DISCORD_API_BASE = "https://discord.com/api/v10";

function parseArgs(argv) {
  const args = {
    channelId: process.env.DISCORD_VISIBLE_REPLY_MONITOR_CHANNEL_ID || DEFAULT_CHANNEL_ID,
    lookbackMinutes: Number(
      process.env.DISCORD_VISIBLE_REPLY_MONITOR_LOOKBACK_MINUTES || DEFAULT_LOOKBACK_MINUTES,
    ),
    replyWindowMinutes: Number(
      process.env.DISCORD_VISIBLE_REPLY_MONITOR_REPLY_WINDOW_MINUTES ||
        DEFAULT_REPLY_WINDOW_MINUTES,
    ),
    botAuthorIds: splitCsv(process.env.DISCORD_VISIBLE_REPLY_MONITOR_BOT_AUTHOR_IDS),
    humanAuthorIds: splitCsv(process.env.DISCORD_VISIBLE_REPLY_MONITOR_HUMAN_AUTHOR_IDS),
    now: Date.now(),
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--channel-id" && next) {
      args.channelId = next;
      index += 1;
    } else if (arg === "--lookback-minutes" && next) {
      args.lookbackMinutes = Number(next);
      index += 1;
    } else if (arg === "--reply-window-minutes" && next) {
      args.replyWindowMinutes = Number(next);
      index += 1;
    } else if (arg === "--bot-author-ids" && next) {
      args.botAuthorIds = splitCsv(next);
      index += 1;
    } else if (arg === "--human-author-ids" && next) {
      args.humanAuthorIds = splitCsv(next);
      index += 1;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return args;
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function printHelp() {
  console.log(`Usage: node scripts/dev/discord-visible-reply-monitor.mjs [options]

Options:
  --channel-id <id>             Discord channel id (default: ${DEFAULT_CHANNEL_ID})
  --lookback-minutes <n>        Message history lookback (default: ${DEFAULT_LOOKBACK_MINUTES})
  --reply-window-minutes <n>    Max minutes before a visible agent reply is expected (default: ${DEFAULT_REPLY_WINDOW_MINUTES})
  --bot-author-ids <csv>        Required: agent/bot Discord author ids that count as visible replies
  --human-author-ids <csv>      Optional human ids to monitor; default is any non-bot/non-agent author
  --json                        Emit JSON report

Environment:
  DISCORD_BOT_TOKEN or DISCORD_TOKEN is required unless --help is used.
`);
}

function snowflakeTimestampMs(id) {
  const raw = BigInt(String(id));
  return Number((raw >> 22n) + 1420070400000n);
}

function isAgentMessage(message, botAuthorIds) {
  const authorId = message.author?.id;
  return Boolean(authorId && botAuthorIds.includes(authorId));
}

function isHumanPrompt(message, { botAuthorIds, humanAuthorIds }) {
  const authorId = message.author?.id;
  if (!authorId || isAgentMessage(message, botAuthorIds)) {
    return false;
  }
  if (humanAuthorIds.length > 0 && !humanAuthorIds.includes(authorId)) {
    return false;
  }
  const text = String(message.content || "").trim();
  return text.length > 0;
}

export function detectVisibleReplyGaps(messages, options) {
  const botAuthorIds = options.botAuthorIds ?? [];
  const humanAuthorIds = options.humanAuthorIds ?? [];
  const replyWindowMs =
    Math.max(0, options.replyWindowMinutes ?? DEFAULT_REPLY_WINDOW_MINUTES) * 60_000;
  const now = options.now ?? Date.now();
  const sorted = messages.toSorted(
    (a, b) => snowflakeTimestampMs(a.id) - snowflakeTimestampMs(b.id),
  );
  const gaps = [];
  for (const message of sorted) {
    if (!isHumanPrompt(message, { botAuthorIds, humanAuthorIds })) {
      continue;
    }
    const promptAt = snowflakeTimestampMs(message.id);
    const deadline = promptAt + replyWindowMs;
    const reply = sorted.find((candidate) => {
      const candidateAt = snowflakeTimestampMs(candidate.id);
      return (
        candidateAt > promptAt && candidateAt <= deadline && isAgentMessage(candidate, botAuthorIds)
      );
    });
    if (!reply && now >= deadline) {
      gaps.push({
        channelId: options.channelId,
        promptMessageId: message.id,
        promptAuthorId: message.author?.id,
        promptAt: new Date(promptAt).toISOString(),
        deadlineAt: new Date(deadline).toISOString(),
        minutesOverdue: Math.floor((now - deadline) / 60_000),
      });
    }
  }
  return gaps;
}

async function fetchDiscordMessages({ token, channelId, lookbackMinutes }) {
  const cutoffMs = Date.now() - Math.max(1, lookbackMinutes) * 60_000;
  const response = await fetch(
    `${DISCORD_API_BASE}/channels/${encodeURIComponent(channelId)}/messages?limit=100`,
    {
      headers: { Authorization: `Bot ${token}` },
    },
  );
  if (!response.ok) {
    throw new Error(`Discord API failed: HTTP ${response.status} ${await response.text()}`);
  }
  const messages = await response.json();
  return messages.filter((message) => snowflakeTimestampMs(message.id) >= cutoffMs);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN or DISCORD_TOKEN is required");
  }
  if (args.botAuthorIds.length === 0) {
    throw new Error(
      "At least one --bot-author-ids entry is required so unrelated bots do not count as delivery evidence",
    );
  }
  const messages = await fetchDiscordMessages({
    token,
    channelId: args.channelId,
    lookbackMinutes: args.lookbackMinutes,
  });
  const gaps = detectVisibleReplyGaps(messages, args);
  const report = {
    ok: gaps.length === 0,
    channelId: args.channelId,
    checkedMessages: messages.length,
    replyWindowMinutes: args.replyWindowMinutes,
    gaps,
  };
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.ok) {
    console.log(`OK: no visible-reply gaps detected in channel ${args.channelId}`);
  } else {
    console.warn(`WARN: ${gaps.length} visible-reply gap(s) detected in channel ${args.channelId}`);
    for (const gap of gaps) {
      console.warn(
        `- prompt=${gap.promptMessageId} author=${gap.promptAuthorId} overdue=${gap.minutesOverdue}m deadline=${gap.deadlineAt}`,
      );
    }
  }
  process.exitCode = report.ok ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
