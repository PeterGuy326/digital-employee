# Contributor guide for coding agents

- Keep the runtime channel-, model-, and source-neutral.
- `profiles/answer-agent` is the first shipped role, not the core product.
- DWS is an optional connector. The console demo must work without DingTalk,
  DWS, or model credentials.
- Never commit credentials, personal identifiers, chat exports, internal URLs,
  private screenshots, or generated knowledge indexes.
- Read operations must use explicit allowlists. Write-capable tools require a
  separate approval policy and are out of scope for the first release.
- Add observable behavior tests for every change. Run `npm run check` before a
  pull request.
