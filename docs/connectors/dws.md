# DWS knowledge source

The DWS connector turns explicitly approved, read-only DingTalk queries into
documents that the digital employee runtime can retrieve and cite. It is
optional: the console demo and filesystem/Git sources work without DWS.

## Security model

The connector intentionally has no discovery mode.

- A stable DWS `profile` is required. It never calls `dws profile list` or
  selects the first/current account.
- Every call must appear in `approvedQueries`; there is no default query.
- Only the read-only command paths listed below are accepted.
- Queries that could otherwise fall back to recent or account-wide data are
  narrowed further: document/drive searches require a keyword, chat searches
  require a group and time range, wiki queries require a workspace, and drive
  listings require a folder, space, or workspace.
- The connector executes `dws` with `spawn(..., { shell: false })`.
- It appends the configured `--profile <profile> --format json` itself.
  Queries cannot override global credentials, profile, output format, `jq`,
  mock, debug, or confirmation flags.
- Child processes have a wall-clock timeout and a combined stdout/stderr size
  limit. Stderr and raw stdout are never copied into errors or logs.

DWS still enforces the permissions of the configured profile. Operators are
responsible for approving the exact documents, meetings, groups, workspaces,
and drive scopes whose contents may be indexed.

## Configuration

Instantiate `DwsKnowledgeSource` with one or more approved queries:

```js
import { DwsKnowledgeSource } from "../../connectors/sources/dws/index.js";

const source = new DwsKnowledgeSource({
  id: "approved-dingtalk-knowledge",
  profile: "corp-id:user-id",
  approvedQueries: [
    {
      name: "deployment-handbook",
      command: ["doc", "read"],
      args: ["--node", "https://alidocs.dingtalk.com/i/nodes/APPROVED_NODE"]
    },
    {
      name: "release-transcript",
      command: ["minutes", "get", "transcription"],
      args: ["--id", "APPROVED_TASK_UUID"]
    },
    {
      name: "support-group",
      command: ["chat", "message", "search"],
      args: [
        "--group",
        "APPROVED_OPEN_CONVERSATION_ID",
        "--query",
        "release",
        "--start",
        "2026-07-01T00:00:00+08:00",
        "--end",
        "2026-08-01T00:00:00+08:00",
        "--limit",
        "50"
      ]
    },
    {
      name: "on-call-wiki",
      command: ["wiki", "node", "search"],
      args: [
        "--workspace",
        "APPROVED_WORKSPACE_ID",
        "--query",
        "on-call"
      ]
    },
    {
      name: "architecture-files",
      command: ["drive", "search"],
      args: ["--query", "architecture", "--target", "file"]
    }
  ]
});

const documents = await source.load();
```

Do not put credentials in this configuration. Authenticate the selected DWS
profile through the DWS CLI. Query names are non-sensitive labels and may
appear in operational logs.

Each loaded document has the common runtime shape:

```js
{
  id: "stable-document-id",
  title: "Source title",
  text: "Extracted source text",
  source: {
    type: "dws",
    id: "DingTalk object id",
    uri: "https://...",       // when returned by DWS
    updatedAt: "2026-..."     // when returned by DWS
  },
  metadata: {
    service: "doc",
    query: "deployment-handbook",
    command: "doc read",
    path: "$.data"
  }
}
```

The extractor walks JSON objects and arrays, recognizes common content fields,
and carries object ID, URL, and time provenance down to nested content.
Credential-like JSON fields are excluded.

## Command allowlist

The allowlist was checked against the runtime schema and leaf help exposed by
DWS `v1.0.55-beta.4` on 2026-07-31. All entries reported
`effect=read`, `risk=low`, `confirmation=not_required`, and
`availability=available`.

| Service | Allowed command | Connector-required scope |
| --- | --- | --- |
| doc | `doc read` | `--node` |
| doc | `doc info` | `--node` |
| doc | `doc search` | `--query` (DWS otherwise returns recent documents) |
| minutes | `minutes get info` | `--id` |
| minutes | `minutes get summary` | `--id` |
| minutes | `minutes get transcription` | `--id` |
| minutes | `minutes get keywords` | `--id` |
| minutes | `minutes get todos` | `--id` |
| chat | `chat message list` | `--group`, `--time`, `--direction` |
| chat | `chat message list-by-ids` | `--msg-ids` (at most 50) |
| chat | `chat message search` | `--group`, `--query`, `--start`, `--end` |
| wiki | `wiki space get` | `--workspace` |
| wiki | `wiki node list` | `--workspace` |
| wiki | `wiki node search` | `--workspace`, `--query` |
| drive | `drive info` | `--node` |
| drive | `drive list` | one of `--folder`, `--space-id`, `--workspace` |
| drive | `drive search` | `--query` |

Shortcuts such as `doc +search`, write commands, file downloads, local output
flags, profile discovery, recent-item feeds, recycle-bin queries, direct-message
history, and account-wide chat search are deliberately excluded.

Because CLI contracts can evolve, verify an installed version before extending
the allowlist:

```bash
dws schema "doc read" --compact --format json
dws doc read --help --format json
```

Schema and help only describe the command contract; they do not read business
data. Add a command only after both sources agree that it is available,
read-only, low-risk, and explicitly scoped.

## Operational limits

Defaults:

- process timeout: 30 seconds;
- combined stdout/stderr: 2 MiB per query;
- extracted documents: 500 per query;
- approved queries: 50 per source.

Override these with `timeoutMs`, `maxOutputBytes`, and
`maxDocumentsPerQuery`, within the connector's hard safety caps.

Search and list commands return only the page requested by the approved query.
The connector never auto-paginates or follows search results into additional
objects. To index a document body, approve an explicit `doc read` query for its
node. To index an AI Minutes transcript, approve an explicit
`minutes get transcription` query for its task UUID.
