#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const BLOCKED = [
  { name: "private key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "GitHub token", pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/ },
  { name: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "absolute macOS user path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: "absolute Linux home path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  {
    name: "internal domain",
    pattern: /\b[a-z0-9.-]+\.(?:corp|internal|intranet)\b/i
  },
  { name: "private chat-derived knowledge", pattern: /\bcommunity-kb(?:\.json)?\b/i }
];

const filesResult = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" }
);
if (filesResult.status !== 0) {
  process.stderr.write("security-check: unable to enumerate repository files\n");
  process.exit(2);
}

const findings = [];
for (const file of filesResult.stdout.split("\0").filter(Boolean)) {
  if (file === "package-lock.json" || file === "scripts/security-check.js") continue;
  let buffer;
  try {
    buffer = await readFile(file);
  } catch {
    continue;
  }
  if (buffer.length > 5 * 1024 * 1024) {
    findings.push(`${file}: file exceeds the 5 MiB public-source limit`);
    continue;
  }
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");
  for (const rule of BLOCKED) {
    if (rule.pattern.test(text)) findings.push(`${file}: blocked ${rule.name}`);
  }
}

if (findings.length) {
  process.stderr.write(`security-check failed:\n${findings.map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("security-check passed\n");
