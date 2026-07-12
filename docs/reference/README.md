# Reference docs

Topic-organised, current-state reference for how TimeLine's features work and
**why** they're built the way they are. Ask about a feature → read its doc here.
These replace the old per-phase docs (`docs/phases/phase-0…7b`), whose durable
content was distilled into these files; the phase-by-phase history lives in git.

| Topic | What's in it |
|---|---|
| [accounts.md](accounts.md) | Identity (no username), auth (JWT httpOnly cookie, CSRF), admin-approval sign-up, ToS/consent, account deletion, password change, reporting, and the security posture (rate-limiting, enumeration) |
| [feed-and-posts.md](feed-and-posts.md) | The reverse-chronological feed, posts, pagination, photos + the imaging pipeline, profiles, `/settings`, and media storage/auth-gating |
| [connections.md](connections.md) | The symmetric **connection** graph and the connection-boundary comment pruning — the visibility predicate everything keys off |
| [messaging.md](messaging.md) | Direct + group messaging, blocking, the clique invariant, interval-clipped history, and the polling model |
| [groups.md](groups.md) | Private invite-only group timelines, membership/roles, and connection-gated in-group visibility |
| [reactions.md](reactions.md) | Emoji reactions on posts/comments/replies and their per-viewer pruning |

**Not here (kept as their own topic docs):**

- [`../SHARED.md`](../SHARED.md) — mission, principles, tech stack, roadmap, repo
  conventions, codebase layout. Read this first.
- [`../design-system.md`](../design-system.md) — the "living line" design system.
- [`../deploy.md`](../deploy.md) — the home-server production runbook **and** the
  "why it's built this way" for ops (Caddy, DDNS, continuous deploy, security
  hardening, cost).
- [`../backup-restore.md`](../backup-restore.md) — off-box encrypted backups + the
  tested restore.

**Future work** still lives phase-by-phase in [`../phases/`](../phases/) — those
are forward-looking plans (8 notifications → 12 open-source/funding), not
reference. When one is built, distil it into a topic doc here and delete the plan.
