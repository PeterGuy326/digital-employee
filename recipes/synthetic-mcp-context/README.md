# Synthetic MCP context recipe

Read-only reference recipe for Issue #36 R1: a neutral employee package that
consumes durable memory (`synthetic-mem`) and version-addressed documents
(`synthetic-doc`) through explicitly granted, read-only MCP capabilities.

Everything here is **synthetic**. Fixtures contain no credentials, no private
URLs, no personal data, and no network dependency. Conformance proven against
these fixtures is never real-service certification.

## Layout

- `employee/` — the portable employee package (`employee.json` declares
  `entrypoints.mcp` and read-only `policy.mcpTools`; it requires the `mcp`
  host capability).
- `grant.json` — the operator-owned `capability-grant.v1` record. It lives
  **outside** the package directory on purpose: a package can never grant
  itself access, and a grant file found inside a package is rejected with
  `mcp_self_grant_rejected`.
- `fixtures/mem.json`, `fixtures/doc.json` — public protocol fixtures with
  active/unapproved/superseded/forgotten memories and listed/revoked/unlisted
  document revisions.

## Frozen decision codes

`mcp_grant_missing`, `mcp_revoked`, `mcp_scope_denied`, `mcp_mode_excessive`,
`mcp_item_unavailable`, `mcp_revision_mismatch`, `mcp_service_unavailable`,
`mcp_self_grant_rejected`, `mcp_grant_invalid`.

## Running it

The recipe executes through the `agent-host-stdio.v1` reference host
(Issue #33). The host environment pins identity and fixture locations:

```
SYNTHETIC_MCP_GRANT=<abs path>/recipes/synthetic-mcp-context/grant.json
SYNTHETIC_MCP_PRINCIPAL=alice
SYNTHETIC_MCP_WORKSPACE=ws-alpha
SYNTHETIC_MCP_MEM_FIXTURE=<abs path>/recipes/synthetic-mcp-context/fixtures/mem.json
SYNTHETIC_MCP_DOC_FIXTURE=<abs path>/recipes/synthetic-mcp-context/fixtures/doc.json
```

Granted runs answer with citation locators of the form
`mem://ws-alpha/<id>@<rev>` and `doc://ws-alpha/<id>@<rev>`; every denied
case fails closed with one of the frozen codes above. See
`tests/apps/synthetic-mcp.test.ts` for the executable acceptance evidence.

## Boundaries

Built-in Host Adapters still reject MCP; only the qualified external
reference adapter declares the `mcp` capability. Writes, implicit capture,
connector catalogs, and production mem/doc clients remain out of scope.
