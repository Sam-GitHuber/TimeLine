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
     `timeline.me` domain choice (see phase-5 notes).

2. **Copyright in user content — the real day-to-day risk.** Friends/family will
   upload photos/text they may not own the rights to. Mitigate with a short
   **Terms of Service** (users grant us a licence to store/display, confirm they
   have the right to post) and a **content-report/takedown path** (US DMCA §512
   safe harbour, UK/EU equivalents). Low probability for a private invite-only
   app, but cheap to cover. **Do before inviting real users (Phase 5).**

3. **Copyright in our own code — a choice, not a risk.** Auto-copyrighted to the
   author; the only decision is which **licence** to release under. Handled
   deliberately at **Phase 10** (MIT/Apache = permissive; AGPL keeps
   network-deployed forks open).

4. **Dependency licences — fine.** Stack is permissive (Django = BSD, React =
   MIT, Postgres). Just keep attribution notices intact and don't pull in a
   copyleft (GPL/AGPL) library unintentionally.

**Not copyright but bigger:** holding real people's data makes us a **data
controller** under GDPR/UK GDPR — need a basic **privacy policy** and a
delete-my-data path before launch (Phase 5). Already aligned with the
privacy-first principle.

## Repo conventions

- `/backend` — Django + Django REST Framework app (managed with `uv`)
- `/frontend` — React (Vite + Tailwind) app
- `/docs` — this file, plus one file per phase in `docs/phases/`
- Root `docker-compose.yml` wires the three services together for local dev
- The original template scaffolding (`src/`, `configuration/`, conda-based
  `requirements/`) is legacy from the repo's starter template and gets removed
  as the real backend/frontend are built — it's not part of the intended stack.

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
