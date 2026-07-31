#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = process.env.FAKE_DWS_MODE ?? "ok";

if (process.env.FAKE_DWS_CAPTURE) {
  writeFileSync(process.env.FAKE_DWS_CAPTURE, JSON.stringify(args), {
    mode: 0o600
  });
}

if (mode === "sleep") {
  setTimeout(() => {
    process.stdout.write('{"late":true}\n');
  }, 10_000);
} else if (mode === "fail") {
  process.stderr.write(
    `${process.env.FAKE_DWS_SECRET ?? "sensitive-stderr"}\n`
  );
  process.exitCode = 7;
} else if (mode === "non-json") {
  process.stdout.write(
    `not-json:${process.env.FAKE_DWS_SECRET ?? "sensitive-stdout"}\n`
  );
} else if (mode === "oversize") {
  process.stdout.write(`{"text":"${"x".repeat(32 * 1024)}"}`);
} else {
  const service = args[0];
  const fixtures = {
    doc: {
      data: {
        nodeId: "doc-42",
        title: "Deployment handbook",
        content: "Use a staged rollout and keep the rollback command ready.",
        url: "https://example.test/docs/doc-42",
        updatedAt: "2026-07-30T08:30:00Z"
      }
    },
    minutes: {
      result: {
        taskUuid: "minutes-7",
        title: "Release planning",
        transcription: "The release window starts Friday at 10:00.",
        url: "https://example.test/minutes/minutes-7",
        modifyTime: 1785400200000
      }
    },
    chat: {
      messages: [
        {
          msgId: "message-9",
          subject: "Support thread",
          content: "The sandbox environment is refreshed every morning.",
          sendTime: "2026-07-30T09:10:00Z"
        }
      ]
    },
    wiki: {
      items: [
        {
          nodeId: "wiki-3",
          name: "On-call guide",
          description: "Escalate incidents after the first failed recovery.",
          url: "https://example.test/wiki/wiki-3",
          modifiedAt: "2026-07-29T12:00:00Z"
        }
      ]
    },
    drive: {
      records: [
        {
          dentryUuid: "drive-5",
          fileName: "Architecture decision",
          snippet: "The service remains read-only in the first release.",
          webUrl: "https://example.test/drive/drive-5",
          modifiedTime: 1785300000000
        }
      ]
    }
  };
  process.stdout.write(`${JSON.stringify(fixtures[service] ?? {})}\n`);
}
