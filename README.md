# Pi Tavily Search

Personal maintenance repository for the existing `tavily_search` Pi extension.
No Pi core or third-party package source is modified.

## Deployment

The deployed extension is `~/.pi/agent/extensions/tavily-search.ts`.
Copy this repository's `tavily-search.ts` to that path and run `/reload` in Pi.
The extension uses Pi's bundled SDK; no separate SDK installation is required.

## Credentials

Credentials live only in `~/.pi/agent/tavily-api-keys.json`, outside this repository.
If `PI_CODING_AGENT_DIR` is set, the file is read from that agent directory instead.
Its shape is an object with an `apiKeys` array of non-empty strings.

Do not commit the real key file, credentials, or session transcripts. Use user-private
filesystem permissions. The key file is read on every search request, so subsequent
key changes do not require a plugin reload.

## Behavior

- Keeps the full existing Search API tool schema and response shape.
- Rotates the starting key between requests and attempts each configured key at most once per request.
- Retries authentication, quota/rate-limit, transient server, network and timeout failures.
- Rejects non-retryable HTTP failures immediately, including invalid request parameters.
- Propagates user cancellation, uses a 120-second timeout per attempt, and redacts Tavily keys in HTTP errors.

Only credential-free source and documentation belong in this repository.
