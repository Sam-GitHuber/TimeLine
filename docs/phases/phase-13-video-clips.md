# Phase 13 — Short video clips

**Status:** not started — sketch only, refine after Phase 11 (see "Hard
precondition"). Captured now to record the *why* and the shape of the work; the
detail is deliberately deferred until the AWS/S3 migration tells us what we're
actually signed up for on cost.

## Goal

Let members post **short video clips** (target: ≤30 seconds) alongside text and
photos in the reverse-chronological feed — same posting flow, same visibility
rules, just a new media type. No live streaming, no long-form video, no
algorithmic "video feed": this is "a photo, but it moves," in keeping with the
sustain-real-connections ethos (see `docs/SHARED.md`).

## Hard precondition — do **not** start before Phase 11

Video is gated on the **AWS/S3 migration (Phase 11)**, not merely sequenced after
it. On the home box the two dominant costs are unacceptable:

- **Playback bandwidth.** Home internet is upload-asymmetric (~tens of Mbps up).
  Every viewer streams the clip back out through that one pipe; a handful of
  people opening the same clip can saturate the uplink and slow the *whole* site.
  A photo is a sub-1 MB one-shot; a clip is ~5–10 MB streamed repeatedly.
- **Durable storage + backup** of files an order of magnitude larger than photos.

On **S3 + a CDN** both largely dissolve: object storage handles durability, and
CDN edge caching absorbs playback egress instead of routing it through a box we
own. So this phase is cheap-*er* and boring-*er* to build after Phase 11, and
genuinely painful before it. **This ordering is the whole reason the doc exists
now but the plan doesn't.**

Note the dependency is on **11 specifically, not 12** — video can land before or
after the open-source/funding phase; only the AWS move is a blocker.

## Why storage is *not* the main worry (the original question)

The instinct was "I only have 1 TB." That turns out to be the *least* of it. With
server-side compression a 30s clip is ~4–9 MB (see table below), so 1 TB is
~100k–250k clips — years of a friends/family network. The real costs are the
**transcoding pipeline** and (pre-AWS) **bandwidth**, not disk.

| Encoding                | ~size for 30s | Clips per 1 TB |
|-------------------------|---------------|----------------|
| 720p H.264 ~2.5 Mbps    | ~9 MB         | ~110,000       |
| 480p H.264 ~1 Mbps      | ~4 MB         | ~250,000       |

## The one genuinely new moving part: a transcode pipeline

Photos go through `process_image` (Pillow) **synchronously**, inside the request —
fast enough. Video cannot work that way:

- Phones record HEVC/H.265 `.mov` at 4K; a raw 30s clip is 50–200 MB. We can't
  store or serve that as-is — it must be re-encoded to compressed, browser-safe
  **H.264/MP4** with **ffmpeg**.
- ffmpeg transcoding takes seconds-to-minutes and would pin a web worker the whole
  time. So it must run **out of band** in a **background job queue** (Celery/RQ +
  a broker such as Redis). That queue is the single biggest new piece of infra
  this phase introduces — larger than storage, larger than the UI.
- The re-encode is also where **metadata stripping** happens (GPS/device — the
  video equivalent of the EXIF strip photos already get) and where a **poster
  frame** thumbnail is generated (reuse the existing thumbnail seam).

## Likely definition of done (refine when we start)

- [ ] `PostVideo` (or extend `PostImage` → generic `PostMedia`) — decide the model
      shape; a post can carry photos **and/or** a clip. Reuse visibility from
      `connections.md`; don't fork the rules.
- [ ] Upload accepts common phone formats; **≤30s enforced** (and a sane input
      byte cap as a DoS guard, mirroring the photo `MAX_UPLOAD_BYTES` rationale)
- [ ] **ffmpeg transcode to H.264/MP4** at a fixed modest profile (720p or 480p —
      decide on cost/quality), **audio normalised**, **metadata stripped**
- [ ] Transcode runs in a **background job queue**, not in the request; the post
      shows a "processing…" state until the clip is ready
- [ ] **Poster-frame thumbnail** generated and served like a photo thumbnail
- [ ] Playback works in-feed; **HTTP range requests (206)** pass cleanly through
      the media-auth proxy for seeking (verify — don't assume)
- [ ] Media served from **S3 + CDN** (Phase 11 seam); auth-gating carried over
- [ ] Storage lifecycle considered (do we keep the original, or only the
      transcode? — leaning "transcode only" to save space)
- [ ] Tests: upload → transcode job → poster + playable clip; oversize/over-length
      rejected; non-video rejected (validate-by-decode, mirroring `process_image`)
- [ ] iPhone/Android apps (Phases 9/10): native capture + client-side trim to 30s
- [ ] `docs/reference/feed-and-posts.md` updated (new media type, the pipeline)

## Open questions to resolve before starting (mostly post-Phase-11)

- **Transcode profile:** 720p vs 480p; single rendition (progressive MP4) vs
  adaptive **HLS**. Start with a single progressive MP4 unless there's a real need
  for adaptive — HLS is a big jump in complexity.
- **Where does ffmpeg run?** A worker container beside the app, or a managed
  transcode service (e.g. AWS MediaConvert)? Cost + ops trade-off — answerable
  only once we know AWS pricing (**feeds the Phase 12 funding number**).
- **Queue/broker choice** (Celery+Redis vs RQ vs a managed queue) — first
  background-job infra in the project; pick the boring one.
- **Keep originals?** Storing only the transcode saves space but is lossy and
  irreversible. Decide explicitly.
- **Moderation surface grows:** 30s of video + audio is harder to eyeball than a
  photo and a bigger risk vector. Lower stakes on a real-identity closed network,
  but note it — no auto-moderation planned, this is a "know the risk" item.

## Notes / decisions log

- **Deferred to after Phase 11 on purpose** — see "Hard precondition." The bet is
  that S3 + CDN turn video from a home-box liability into an ordinary feature.
- **Reuse, don't fork.** Visibility, auth-gated media, unguessable UUID filenames,
  the thumbnail seam, and the "input cap is a DoS guard not a storage limit"
  reasoning all already exist for photos in `feed-and-posts.md` — video should
  extend that machinery, not duplicate it.
- **Scope discipline:** 30s cap, no live, no long-form, no separate video feed.
  This is a media type, not a product pivot. Keep it that way.
