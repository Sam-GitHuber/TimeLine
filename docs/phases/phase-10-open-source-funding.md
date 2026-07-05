# Phase 10 — Open Source & Funding

**Status:** not started — sketch only, refine before starting

## Goal

Make TimeLine a *proper* open-source project that outsiders can understand and
contribute to, and open a funding channel (e.g. Patreon) to cover hosting so the
project can grow beyond friends/family — **without ever adding ads, tracking, or
an algorithm** (see `docs/SHARED.md`).

The repo is public from day one; this phase is about doing open source *well*,
once there's a real product worth contributing to and funding.

## Runnable product / deliverable at the end of this phase

A public repo that a stranger can clone, run locally (thanks to the Docker
setup), and contribute to — plus a live funding page linked from the project.

## Likely definition of done (refine when we start)

- [ ] Open-source LICENSE chosen and added
- [ ] Clear README: what it is, the ethos, how to run it locally, how to deploy
- [ ] CONTRIBUTING guide + code of conduct
- [ ] Issue/PR templates; "good first issue" labels
- [ ] Documented privacy practices (what data is stored, how, user rights) —
      the ethical stance made concrete for users and contributors
- [ ] Funding channel set up (e.g. Patreon) and linked, with an honest
      breakdown of what money goes toward (hosting first — see Phase 7 costs)
- [ ] A short public roadmap so contributors know where it's heading

## Open questions to resolve before starting

- Which license best fits the ethos (e.g. a copyleft license to keep
  derivatives open)?
- How to accept contributions safely given it holds real user data (review
  process, who can deploy)?

## Notes / decisions log

- **Licence choice ties to the ethos (see Legal / IP in `docs/SHARED.md`).**
  Our code is auto-copyrighted to the author; the licence is a deliberate
  choice. **AGPL-3.0** is worth strong consideration: it's copyleft *including
  over-the-network use*, so anyone running a modified TimeLine as a service must
  publish their changes — the best fit for keeping derivatives open and
  ad/algorithm-free. Trade-off: AGPL deters some commercial adopters (fine for
  this project). Permissive (MIT/Apache-2.0) is the alternative if wider reuse
  matters more than keeping forks open.
- **Funding model is explicitly non-profit.** Stated intent: donations
  (Patreon etc.) cover hosting costs first; any material excess is donated to
  charity. The funding page should state this breakdown honestly. Note:
  "non-profit" here is an operating stance — formal non-profit/charity
  *incorporation* is a separate legal step, not required to run this way, but
  worth a lawyer's input if donation volume ever grows.
