# Security

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's private
vulnerability reporting on this repository, or open a public issue that says only
"security report, please enable private reporting" with no detail.

Expect an acknowledgement within a few days.

## Threat model

Sift is single-user software that binds to loopback and holds no credentials a
page in your browser could not already exercise as you. That shapes what counts
as a vulnerability here.

**In scope**

- Anything letting a web page reach the local API. The extension's content
  scripts deliberately have no path to the server; everything routes through the
  service worker, which verifies a `service: "sift"` handshake first.
- Injection through the ingestion endpoint. Captured content comes from pages we
  do not control and is parsed with Zod, never cast, and never interpolated into
  SQL.
- FTS query construction. User input goes near SQL here; every term is quoted and
  every FTS operator character is stripped, so no query can be interpreted as
  syntax. A malformed expression must degrade to "no keyword hits", never a 500.
- Exfiltration of a stored API key. Keys are write-only: `PUT /settings/keys`
  accepts one and no endpoint ever returns it — `GET /settings` reports only
  whether one is set.
- Prompt injection reaching an *action*. Sift's AI features read and write text;
  they never call tools, never navigate, and never act on the user's behalf.
  Captured content certainly contains injection attempts, and the worst it can do
  is produce a bad summary.
- Path traversal in export or share-card endpoints.
- The MAIN-world interceptor, which runs in a realm the page controls. It must
  never grant the page more capability than it already had.

**Out of scope**

- Anything requiring an attacker to already run code on your machine.
- Binding to a public interface. `SIFT_HOST` exists for containers; setting it to
  `0.0.0.0` on an untrusted network is a configuration choice, not a bug.
- The absence of authentication. The trust boundary is the loopback interface.
- Rate limiting. There is one user.

## Design decisions relevant to security

- **No native modules.** The whole class of memory-safety bugs in a native SQLite
  binding is absent because SQLite comes from Node's own build.
- **Narrow extension permissions.** Three hosts plus loopback. No `<all_urls>`,
  no `tabs`, no `cookies`, no `webRequest`. Page capture rides on `activeTab`, so
  it can only run where you invoked it.
- **CORS by scheme, not allowlist.** Extension origins are unknowable ahead of
  time, so `chrome-extension://` and `moz-extension://` are admitted by scheme and
  everything that is not an extension or localhost is refused.
- **Secrets are separate rows.** API keys live under a `secret:` prefix in `kv`
  and are read only by the provider layer.
- **`data/` is gitignored.** Your corpus and your keys cannot be committed by
  accident.

## What Sift does not send anywhere

There is no telemetry, no crash reporting, no analytics, and no update check.
The only outbound requests are to the sources you configured and, if you supply a
key, to the AI provider you chose. `grep -r "analytics\|telemetry\|track(" .`
returns nothing.
