import assert from "node:assert/strict";
import test from "node:test";
import { GitSource } from "../../connectors/sources/git/index.js";

test("Git source accepts a credential-free HTTPS repository", () => {
  const source = new GitSource({
    id: "public-docs",
    remote: "https://github.com/example/example.git",
    ref: "main"
  });
  assert.equal(source.remote, "https://github.com/example/example.git");
});

test("Git source rejects embedded credentials and unsafe schemes", () => {
  assert.throws(
    () =>
      new GitSource({
        id: "unsafe",
        remote: "https://token@example.test/repo.git"
      }),
    /without_credentials/
  );
  assert.throws(
    () =>
      new GitSource({
        id: "unsafe",
        remote: "ssh://git@example.test/repo.git"
      }),
    /public_https/
  );
});

test("Git source rejects command-like refs", () => {
  assert.throws(
    () =>
      new GitSource({
        id: "unsafe",
        remote: "https://example.test/repo.git",
        ref: "main; touch bad"
      }),
    /invalid_ref/
  );
});
