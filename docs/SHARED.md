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
| Auth | Django's built-in auth (+ token auth for the API) | Don't hand-roll login/password/session logic. Token-based auth (e.g. `dj-rest-auth`/`djoser`) so web and mobile can share it |
| Admin / moderation | Django admin | Free ready-made UI to manage users/posts, approve sign-ups, moderate — big win for a solo-run community |
| Database | PostgreSQL | Runs as its own Docker container |
| Frontend | React + Vite | Vite chosen over Next.js — don't need server rendering yet |
| Styling | Tailwind CSS | Fast to build with; pairs with the `frontend-design` plugin |
| Data fetching (frontend) | TanStack Query | Handles loading/refreshing feed data cleanly |
| Python packaging | uv | Fast, modern Python package/venv manager |
| Photo storage | S3-compatible object storage (via `django-storages`) | Phase 4+. Local folder for dev |
| Local dev / packaging | Docker Compose | Three services: `frontend`, `backend`, `postgres` |
| CI | GitHub Actions | Runs tests automatically on push (`.github/workflows/`) |
| Hosting (future) | AWS Lightsail | Cheap on-ramp to AWS. Phase 5 |

### Add later — only when actually needed (do NOT build these now)

Deliberately deferred to avoid over-engineering the family MVP. Each has a
well-known path when the time comes:

| Piece | Add when |
|---|---|
| Redis (caching / faster feeds) | The feed gets slow under real traffic |
| Background job queue (Celery/RQ) | Need image processing, notifications, emails |
| Django Channels (WebSockets) | Real-time messaging (Phase 6) |
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

## Repo conventions

- `/backend` — Django + Django REST Framework app (managed with `uv`)
- `/frontend` — React (Vite + Tailwind) app
- `/docs` — this file, plus one file per phase in `docs/phases/`
- Root `docker-compose.yml` wires the three services together for local dev
- The original template scaffolding (`src/`, `configuration/`, conda-based
  `requirements/`) is legacy from the repo's starter template and gets removed
  as the real backend/frontend are built — it's not part of the intended stack.

## Roadmap (phases)

Detailed plans live in `docs/phases/`, one file each. **Every phase ends in
something that can actually be run and tested** — a demoable product, not just
internal plumbing. Later phases are sketched now but get refined into full
detail when we're about to start them.

| # | Phase | What you can run/test at the end | Doc |
|---|---|---|---|
| 0 | Prove the stack | `docker compose up` runs Django + React + Postgres talking to each other | `phase-0-docker-skeleton.md` |
| 1 | Wireframe web app | A clickable, locally-runnable wireframe of the timeline UI, using mock data | `phase-1-wireframe.md` |
| 2 | Accounts & auth | Sign up, log in, log out — real user accounts in the database | `phase-2-accounts.md` |
| 3 | MVP timeline | Post text, follow people, see a real reverse-chronological feed of who you follow | `phase-3-mvp-timeline.md` |
| 4 | Photos & profiles | Attach photos to posts; browse a person's profile page | `phase-4-photos-profiles.md` |
| 5 | Productionisation | The app live on a private URL (AWS Lightsail) with HTTPS + backups; friends/family can log in | `phase-5-productionisation.md` |
| 6 | Direct messaging | One-to-one private messages between users | `phase-6-messaging.md` |
| 7 | Groups | Shared group timelines you can post into and follow | `phase-7-groups.md` |
| 8 | iPhone app | An installable iOS app hitting the same backend | `phase-8-iphone-app.md` |
| 9 | Android app | An installable Android app hitting the same backend | `phase-9-android-app.md` |
| 10 | Open source & funding | Public repo with license + contribution guide, and a funding channel (e.g. Patreon) | `phase-10-open-source-funding.md` |

### Why this order

- **Wireframe (1) before real features.** Seeing the UI early — even faked —
  makes it obvious what data the backend actually needs, and gives quick,
  motivating progress before the harder plumbing.
- **Auth (2) before posting (3).** Everything else assumes "who is logged in,"
  so accounts come first.
- **Productionise (5) before messaging/groups.** Once real friends/family are
  using it, later features ship to a live app you can dogfood — you get real
  feedback instead of guessing.
- **Apps (8–9) after the web app is solid.** The phone apps talk to the same
  backend, so there's no point building them until that backend is stable and
  deployed.
- **Open source & funding (10) last of the planned set,** but the repo stays
  public throughout — phase 10 is about doing it *properly* (license,
  contribution guide) and asking for money only once there's a real product
  worth funding.
