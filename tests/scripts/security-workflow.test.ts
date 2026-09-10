import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const workflow = YAML.parse(await readFile(
  new URL("../../.github/workflows/bytefolk-security.yml", import.meta.url),
  "utf8"
));

test("required CodeQL check runs for fork and same-repository pull requests", () => {
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.equal(workflow.on.pull_request, null, "PR analysis must not be filtered");
  const codeql = workflow.jobs.codeql;
  assert.equal(codeql.if, undefined, "CodeQL must not skip fork PRs before matrix expansion");
  assert.equal(codeql.name, "CodeQL (${{ matrix.language }})");
  assert.deepEqual(codeql.strategy.matrix.language, ["javascript-typescript"]);
  for (const step of codeql.steps) {
    assert.equal(step.if, undefined, "required analysis steps must not be skipped");
  }
  const init = codeql.steps.find((step: { uses: string }) => step.uses.startsWith("github/codeql-action/init@"));
  assert.equal(init.with.languages, "${{ matrix.language }}");
  assert.equal(init.with.queries, "security-extended");
  assert.ok(codeql.steps.some((step: { uses: string }) => step.uses.startsWith("github/codeql-action/analyze@")));
});

test("fork CodeQL analysis retains the unprivileged PR execution boundary", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.codeql.permissions, {
    contents: "read",
    actions: "read",
    packages: "read",
    "security-events": "write"
  });
  for (const step of workflow.jobs.codeql.steps) {
    assert.match(step.uses, /@[0-9a-f]{40}$/);
    assert.equal(step.run, undefined);
    if (step.uses.startsWith("actions/checkout@")) {
      assert.equal(step.with["persist-credentials"], false);
      assert.equal(step.with.ref, undefined, "scan the default PR merge ref");
    }
  }
});
