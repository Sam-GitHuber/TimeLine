# TimeLine — Shared Project Reference

Cross-phase information for the TimeLine project. Read this before starting work on
any phase. Phase-specific plans live in `docs/phases/`.

## Mission

A social media site that has no algorithm and no monetisation. Just a timeline of
your friends, family, and anyone else you follow, in the order they posted —
what Facebook was supposed to be.

## Principles

These constrain every feature decision, not just the pitch:

- **Reverse-chronological only.** No ranking, no engagement-optimised ordering,
  ever. If a feature needs a "relevance score," it's the wrong feature.
- **No ads, no monetisation of attention.** Funding (see Roadmap) comes from
  people who want the project to exist, not from selling attention or data.
- **Privacy-first.** Real friends' and family's photos and posts live here.
  No third-party trackers/analytics. Default to private, not public.
- **Open source.** The repo is public and open to contributions from the start.

## Current stage

Starting small and private: just for the maintainer's friends and family.
No public sign-ups yet. Funding (e.g. Patreon) is a later-phase concern, only
once the product is solid — see the Roadmap below.

## Tech stack

### Use from the start

| Piece | Choice | Notes |
|---|---|---|
| Backend | Django + Django REST Framework (Python) | Batteries-included: bundles auth, ORM, migrations, and a free admin panel. Instagram/Pinterest run on Django — proven at global scale. DRF exposes the data as a JSON API for the React app + future mobile apps |
| DB access + migrations | Django ORM + built-in migrations | Integrated into Django — no separate tools needed |
| Auth | Django's built-in auth + `dj-rest-auth`/`allauth`/`simplejwt` | Don't hand-roll login/password/session logic. Implemented in Phase 2: **email login** (custom `accounts.User`, no username), JWT delivered in an **httpOnly cookie**, sign-ups **admin-approved** (`is_active`). Token-based so web + future mobile share it |
| Admin / moderation | Django admin | Free ready-made UI to manage users/posts, approve sign-ups, moderate — big win for a solo-run community |
| Database | PostgreSQL | Runs as its own Docker container |
| Frontend | React + Vite | Vite chosen over Next.js — don't need server rendering yet |
| Routing (frontend) | react-router-dom (v6) | The standard React SPA router. Real URLs + back-button/shareable links. Added in Phase 1 |
| Styling | Tailwind CSS | Fast to build with; pairs with the `frontend-design` plugin |
| Data fetching (frontend) | TanStack Query | Handles loading/refreshing feed data cleanly. Add when the frontend first talks to the real API (Phase 3) |
| Frontend tests | Vitest + React Testing Library | The standard test runner for Vite/React. `npm test`. Added in Phase 1 |
| Python packaging | uv | Fast, modern Python package/venv manager |
| Photo storage | S3-compatible object storage (via `django-storages`) | Built via `django-storages` from Phase 4, but backed by a **local disk volume** through the home-server beta (Phase 7); switches to an S3 bucket at the AWS migration (Phase 11) as a config change, not a rewrite |
| Local dev / packaging | Docker Compose | Three services: `frontend`, `backend`, `postgres` |
| CI | GitHub Actions | Runs tests automatically on push (`.github/workflows/`) |
| Hosting (future) | Home server first, then AWS Lightsail | Phase 7 self-hosts the finished app on a wiped spare PC for a cheap, reversible friends/family beta; Phase 11 migrates all data to AWS Lightsail once it's proven |

### Add later — only when actually needed (do NOT build these now)

Deliberately deferred to avoid over-engineering the family MVP. Each has a
well-known path when the time comes:

| Piece | Add when |
|---|---|
| Redis (caching / faster feeds) | The feed gets slow under real traffic |
| Background job queue (Celery/RQ) | Need image processing, notifications, emails |
| Django Channels (WebSockets) | Real-time messaging (Phase 5) |
| CDN for images | Users are geographically far from the server |
| Load balancer + multiple backend copies | One server isn't enough (a good problem) |

Do not swap any "from the start" choice without discussing it first — they were
chosen deliberately for this project and this stage of the author's experience.

## Does this scale to a global social network?

Yes — and it's worth internalising *why*, because it prevents a common trap:

- **The web framework does not cap your scale.** Instagram and Pinterest are
  Django. What determines scalability is *architecture* (database design,
  caching, CDNs, running multiple backend copies), not the framework — and all
  of those are things you add later, when user numbers justify them.
- **Frontend/backend are kept separate on purpose.** The Django backend is just
  a JSON API; the React web app is one client of it, and the future iPhone/
  Android apps are just more clients of the *same* API. That separation is the
  single most future-proofing decision in the project, and it's baked in.
- **Build for today, not for a billion users.** With a handful of family members
  using it, engineering for global scale would waste time and money. The
  "add later" table above is the plan for scale — we reach for it only when
  real usage demands it.

## Legal / IP considerations

Being **non-profit does not grant immunity** from copyright or trademark claims —
infringement is about *use*, not profit, and donation-funded operation still
counts as operating publicly. Not legal advice; this is a running note of what's
worth a real lawyer's time. Four distinct issues:

1. **Trademark — the name "TimeLine" (the one hard-to-reverse decision).**
   - "Timeline" is a **descriptive/generic** term for a social feed, so it's
     hard for *anyone* to own broadly — but also hard for *us* to protect, and a
     confusingly-similar branded use in the *same product category* can still
     draw a claim.
   - **Directly relevant precedent:** *Timelines, Inc. v. Facebook* (2011–2013).
     Timelines Inc. held registered marks for "Timelines"/"Timelines.com" for a
     site to create and share chronologies (a social product), sued Facebook
     over its "Timeline" feature, and **Facebook settled** (2013). Same category
     as us. Whether that mark is still live needs a direct USPTO check.
   - The space is crowded with active "Timeline" companies (e.g. `timeline.co`
     financial-planning software, Timeline longevity supplements, `timelines.app`
     time-tracking) — mostly *different* classes from social networking, but it
     shows the word is heavily used.
   - **Takeaway:** a bare-dictionary-word brand is weak and slightly risky in
     this category. A **suggestive/coined brand** (think "Instagram") is far
     safer to own and defend. Do a proper trademark search in software/
     social-networking classes at your national IP office (UK IPO / IP Australia
     — note British/AU spelling in this repo) **and** the US
     (`tmsearch.uspto.gov`) before locking the brand. Weigh this against the
     domain choice (`your-timeline.net`, purchased — see `deploy.md`).

2. **Copyright in user content — the real day-to-day risk.** Friends/family will
   upload photos/text they may not own the rights to. Mitigate with a short
   **Terms of Service** (users grant us a licence to store/display, confirm they
   have the right to post) and a **content-report/takedown path** (US DMCA §512
   safe harbour, UK/EU equivalents). Low probability for a private invite-only
   app, but cheap to cover. **Do before inviting real users (Phase 7).**

3. **Copyright in our own code — a choice, not a risk.** Auto-copyrighted to the
   author; the only decision is which **licence** to release under. Handled
   deliberately at **Phase 12** (MIT/Apache = permissive; AGPL keeps
   network-deployed forks open).

4. **Dependency licences — fine.** Stack is permissive (Django = BSD, React =
   MIT, Postgres). Just keep attribution notices intact and don't pull in a
   copyleft (GPL/AGPL) library unintentionally.

**Not copyright but bigger:** holding real people's data makes us a **data
controller** under GDPR/UK GDPR — need a basic **privacy policy** and a
delete-my-data path before launch (Phase 7). Already aligned with the
privacy-first principle.

## Repo conventions

- `/backend` — Django + Django REST Framework app (managed with `uv`)
- `/frontend` — React (Vite + Tailwind) web app (JavaScript)
- `/mobile` — Expo (React Native) iOS + Android app, **TypeScript** (Phase 9).
  One folder serves both platforms; `mobile/ios` and `mobile/android` are
  generated and gitignored. Its `node_modules` and deps are entirely separate
  from `frontend`'s — the two are not a workspace.
- `/docs` — this file + `design-system.md` + the ops runbooks (`deploy.md`,
  `backup-restore.md`); **`docs/reference/`** = how each shipped feature works and
  why (start there for a feature question); **`docs/phases/`** = forward-looking
  plans for work not yet built (notifications → open-source).
- Root `docker-compose.yml` wires the three services together for local dev
- The original template scaffolding (`src/`, `configuration/`, conda-based
  `requirements/`) is legacy from the repo's starter template and gets removed
  as the real backend/frontend are built — it's not part of the intended stack.

**Codebase layout (the load-bearing facts):**

- The Django project is named **`config`**; features live in two apps — **`api`**
  (posts, feed, connections, comments, messaging, groups, reactions, reports) and
  **`accounts`** (the custom user model + auth serializers). `config/urls.py`
  includes `api/urls.py`.
- **Settings are env-driven** (`config/settings.py` reads `os.environ` with
  dev-safe defaults); `docker-compose.yml` supplies them via `${VAR:-default}` so
  `docker compose up` works with no `.env`. Secrets are env-only (guarded — the app
  refuses to boot with `DEBUG` off and no `DJANGO_SECRET_KEY`).
- **Tailwind v4** uses the `@tailwindcss/vite` plugin + a single
  `@import "tailwindcss";` — no `tailwind.config.js`/PostCSS (differs from the v3
  setup most tutorials show). Design tokens live in a `@theme` block; see
  `design-system.md`.
- **Frontend → backend URL:** the browser calls the published host port (e.g.
  `http://localhost:8000` via `VITE_API_URL`), *not* the Docker service name —
  which is why CORS is required in dev.
- Two dev gotchas worth remembering: a bind-mounted shell script loses its exec
  bit (run it via `CMD ["bash", "..."]`, not the exec bit), and `db` has a
  `pg_isready` healthcheck the backend waits on so startup order is safe.

### Running the dev stack (read this before `docker compose up`)

- **Always build:** `docker compose up --build` (add `-d` to background). A plain
  `up` reuses a stale image, so newly-added dependencies or Dockerfile changes
  silently don't take effect.
- **When you add or bump a dependency, `--build` alone is not enough** — also
  renew the anonymous `node_modules` volume:

  ```
  docker compose up -d --build --renew-anon-volumes frontend
  ```

  Why: the compose file mounts an anonymous volume over `/app/node_modules` (so
  the container keeps its Linux-built modules, not the host's macOS ones). That
  volume survives `up --build` and **shadows** the freshly-built image's
  `node_modules`, so the container keeps the old install and Vite errors with
  `Failed to resolve import "<new-dep>"`. Renewing the volume repopulates it from
  the new image. Ordinary source edits hot-reload fine — this only bites on
  dependency changes, and CI is unaffected (it runs `npm ci` fresh). Hit in
  Phase 3 after adding `@tanstack/react-query`. (Same idea applies to the backend
  image when Python deps change.)

## Roadmap (phases)

**Every phase ends in something that can actually be run and tested** — a
demoable product, not just internal plumbing. **Done** phases (0–8b) are no longer
tracked one-file-each; their durable reference lives in `docs/reference/` (and the
ops runbooks) — the "Doc" column below points there. **Future** phases (9–12) are
still plans in `docs/phases/`, sketched now and refined into full detail when
we're about to start them; when one ships, its plan is distilled into a reference
doc and deleted.

| # | Phase | What you can run/test at the end | Status · Doc |
|---|---|---|---|
| 0 | Prove the stack | `docker compose up` runs Django + React + Postgres talking to each other | done · `SHARED.md` (codebase layout) |
| 1 | Wireframe web app | A clickable, locally-runnable wireframe of the timeline UI, using mock data | done · (superseded by real UI) |
| 2 | Accounts & auth | Sign up, log in, log out — real user accounts in the database | done · `reference/accounts.md` |
| 3 | MVP timeline | Post text, connect with people, see a real reverse-chronological feed | done · `reference/feed-and-posts.md`, `reference/connections.md` |
| 4 | Photos & profiles | Attach photos to posts; browse a person's profile page | done · `reference/feed-and-posts.md` |
| 5 | Direct messaging | One-to-one private messages between users | done · `reference/messaging.md` |
| 6 | Groups | Shared group timelines you can post into | done · `reference/groups.md` |
| 6a | Group messaging | Group conversations (extends DMs); leave a conversation | done · `reference/messaging.md` |
| 7 | Self-hosted private beta | The finished app live on a wiped spare **home PC**, on a real HTTPS URL; close friends/family log in and bug-test it | done · `deploy.md`, `backup-restore.md` |
| 7b | Emoji reactions | React to any post/comment/reply with any keyboard emoji; aggregated counts respecting visibility | done · `reference/reactions.md` |
| 8 | Notifications & activity centre | An in-site notification centre (kept, not vanishing on tap; handled ones dulled) with per-type preferences; events for post/comment replies, reactions, connection requests, group invites | done · `reference/notifications.md` |
| 8b | Group events & planning calendar | Plan group events (title/date/time/location) with advisory date/time/location/custom polls; upcoming events on the group timeline + a month grid + a personal `/calendar` | done · `reference/events.md` |
| 9 | iPhone app | An installable iOS app hitting the same backend, with push notifications | planned · `phases/phase-9-iphone-app.md` |
| 10 | Android app | An installable Android app hitting the same backend, with push notifications | planned · `phases/phase-10-android-app.md` |
| 11 | Migrate to AWS | All beta data (accounts, posts, comments, photos) moved to **AWS Lightsail** with no data loss; same URL, always-on | planned · `phases/phase-11-aws-migration.md` |
| 12 | Open source & funding | Public repo with license + contribution guide, and a funding channel (e.g. Patreon) | planned · `phases/phase-12-open-source-funding.md` |

### Why this order

- **Wireframe (1) before real features.** Seeing the UI early — even faked —
  makes it obvious what data the backend actually needs, and gives quick,
  motivating progress before the harder plumbing.
- **Auth (2) before posting (3).** Everything else assumes "who is logged in,"
  so accounts come first.
- **Messaging (5) and groups (6) before productionising (7).** We cement the
  full data model — DMs and groups, not just the timeline — *before* the app
  holds any real data. Schema changes are cheap now and painful once there are
  live rows to migrate, so we productionise once, with the feature set settled,
  rather than re-deploying and migrating after each feature. (Trade-off: real
  friends/family start using it later, so early usage doesn't shape the
  messaging/groups design — a deliberate choice; the maintainer wants a genuinely
  solid site before inviting anyone.)
- **Home-server beta (7) first, cloud (11) only once proven.** Rather than
  paying for cloud hosting on day one, we self-host the finished app on a wiped
  spare PC for a friends/family beta — cheap and fully reversible, so if it flops
  we've spent nothing but a domain. **The AWS migration is deliberately pushed
  back behind the phone apps** (see below): we spend cheap engineering time to
  generate real demand before committing to recurring cloud cost. Once that
  demand is proven, Phase 11 migrates all the real data to AWS Lightsail. The
  known cost is a one-time home→cloud data migration, deliberately accepted and
  de-risked by designing storage so photos move to a bucket once and never move
  again.
- **Notifications (8) before the apps.** The notification *system* — the event
  types, the in-site activity centre (which keeps a history rather than losing a
  notification the moment it's tapped), and per-type preferences — is backend +
  web work that's independent of any phone, and it makes the web app better on
  its own. Building it first means each app phase just adds the *push delivery
  channel* (Apple's APNs / Google's FCM) on top of an API that already exists,
  rather than one giant phase that invents the whole notification concept and an
  app at the same time. Same layering as the `django-storages` seam: build the
  hard shared part once, add the platform-specific channel later.
- **Apps (9–10) run on the home-server beta, before AWS.** The phone apps are
  just more clients of the same JSON API, so their real dependency is a stable
  public HTTPS backend — which the home server already provides (Phase 7), not
  AWS. We build the apps to prove that people will actually use TimeLine once
  they can download it (and get push notifications), *then* let that proven
  demand justify paying for always-on cloud hosting. If the apps ever strain the
  home PC, that strain is itself the signal to do the migration. Distribution via
  TestFlight / Play closed-testing keeps the beta invite-only, and sign-ups stay
  admin-approved, so wider app reach never means uncontrolled data exposure.
- **Open source & funding (12) last of the planned set,** but the repo stays
  public throughout — phase 12 is about doing it *properly* (license,
  contribution guide) and asking for money only once there's a real product
  worth funding.
