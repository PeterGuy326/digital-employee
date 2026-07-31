# Security policy

## Reporting

Do not open a public issue for credential exposure, authorization bypass,
private-data disclosure, SSRF, command injection, or another vulnerability.
Use GitHub's private vulnerability reporting for this repository.

## Data boundary

Digital Employee is self-hosted, but configured model and source providers may
receive data. Operators are responsible for:

- approving each indexed source;
- choosing a model provider permitted to process that data;
- setting retention and deletion policies;
- protecting DingTalk, DWS, and model credentials;
- reviewing citations and audit events before enabling any write action.

OpenAI-compatible provider URLs are operator configuration, not user input.
Without `allowPrivateNetwork`, the adapter rejects literal and DNS-resolved
private addresses before each request. Keep TLS verification enabled and do not
delegate model endpoint configuration to untrusted callers.

The `answer-agent` profile is read-only. It does not grant permission to scan
an account, organization, drive, chat history, or repository automatically.

## Supported versions

Until the first stable release, only the latest tagged `0.x` release receives
security fixes.
