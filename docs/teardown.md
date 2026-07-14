# Tearing TimeLine down

If you ever decide to shut TimeLine down for good, this is the checklist for
**destroying every credential and closing every account** so nothing is left
running, billable, or holding data after you walk away.

It's the mirror image of `docs/deploy.md` (stand-up) and `docs/backup-restore.md`
(the backup/R2 setup). Keep it in sync: **if you sign up for a new service or add
a new API key, add a row here.**

> **You are a data controller.** This app holds real friends'/family's personal
> data (accounts, posts, photos, messages). Before you destroy anything, do the
> right thing by them first — see [Before you start](#before-you-start). Deleting
> the data is *part* of teardown, not an afterthought.

---

## Service & credential inventory

Every external account this project depends on, what it holds, and where the
secret lives on the server. Work top to bottom in the [checklist](#teardown-checklist).

| Service | What it's for | Secret / resource | Where it lives |
|---------|---------------|-------------------|----------------|
| **Cloudflare — Registrar** | Owns `your-timeline.net` | The domain registration (at-cost annual renewal) | Cloudflare dashboard → Domain Registration (same account as DNS + R2) |
| **Cloudflare — DNS** | Public DNS for the domain + DDNS updates | **DDNS API token** (Edit-zone-DNS) | `/etc/timeline/cloudflare-ddns.env` → `CF_API_TOKEN` |
| **Cloudflare — R2** | Off-site encrypted backups | Bucket `timeline-backups` + an **R2 API token** (Access Key ID + Secret) | rclone config: `~/.config/rclone/rclone.conf` |
| **Cloudflare — Resend link** | Resend's access to auto-manage DNS records | An **authorized app / API connection** granted during Resend domain setup | Cloudflare dashboard (not a file) |
| **Resend** | Outbound email (password resets, etc.) | Verified domain + **sending API key** (`re_…`) | `~/TimeLine/.env.prod` → `EMAIL_HOST_PASSWORD` |
| **healthchecks.io** | Uptime + backup dead-man's-switch alerts | Two checks, each with a **ping URL** (`hc-ping.com/<uuid>`) | `/etc/timeline/healthcheck.env` → `PING_URL` and `/etc/timeline/backup.env` → `HEALTHCHECK_URL` |
| **GitHub** | Code repo, CI (Actions), image registry (GHCR) | Repo `Sam-GitHuber/TimeLine`; packages `timeline-backend`, `timeline-web`; maybe a read-only **deploy key** on the box | GitHub account; deploy key in `~/.ssh/` on the server (if used) |
| **Let's Encrypt** | HTTPS certificates | ACME account key (auto-managed by Caddy) | **Nothing to do** — no dashboard, no bill; certs just expire when Caddy stops |

On-server secrets that aren't external accounts but must still be destroyed (they
grant access to the above, or *are* user data):

| Secret / data | Where | Why it matters |
|---------------|-------|----------------|
| `.env.prod` | `~/TimeLine/.env.prod` | Django `SECRET_KEY`, Postgres password, Resend key |
| `/etc/timeline/*.env` | server | Cloudflare token + healthcheck ping URLs |
| `rclone.conf` | `~/.config/rclone/rclone.conf` | R2 keys **and the crypt password/salt** that decrypts every backup |
| Live app data | `/srv/timeline/` (NVMe) | The Postgres database + uploaded media — **real users' personal data** |
| Off-site backups | Cloudflare R2 `timeline-backups` | Encrypted copies of that same personal data |

---

## Before you start

1. **Tell your members.** Give people notice and, if they want it, a way to get
   their own content out first (the app has account self-deletion; you can also
   dump their data manually — see `docs/deploy.md` → "Handling reports &
   deletion requests"). As the data controller you're expected to delete their
   data on wind-down anyway.
2. **Decide if you want a final export for yourself.** If there's any chance you
   restart later, keep one final encrypted backup + a copy of `rclone.conf`
   somewhere safe **before** you delete the R2 keys — without the crypt
   password/salt in that file, the backups are unrecoverable ciphertext. If this
   is a clean permanent shutdown, skip this and let it all go.

---

## Teardown checklist

Ordered to avoid false alarms and lock-outs (kill the alerting *before* you stop
the box, revoke tokens *before* you delete the accounts that manage them).

### 1. Silence monitoring (so teardown doesn't page you)
- [ ] In **healthchecks.io**, pause or delete both checks (uptime + backup).
      Otherwise stopping the server trips a "down" alert mid-teardown.

### 2. Stop the app on the server
- [ ] `cd ~/TimeLine && docker compose -f docker-compose.prod.yml down`
- [ ] Disable the systemd timers so nothing restarts it or runs backups:
      `sudo systemctl disable --now timeline-deploy.timer cloudflare-ddns.timer timeline-backup.timer timeline-healthcheck.timer`
      (skip any you never installed).

### 3. Revoke every API key / token
- [ ] **Resend** → API Keys → delete the `timeline-prod` key. Optionally remove
      the domain too.
- [ ] **Cloudflare → My Profile → API Tokens** → delete the **DDNS** token.
- [ ] **Cloudflare → R2 → Manage R2 API Tokens** → delete the backup token.
- [ ] **Cloudflare → Resend authorization** → revoke Resend's access to your DNS
      (Manage Account → the authorized-apps/connections list). Deleting the zone
      later also severs this, but revoke it explicitly to be sure.
- [ ] **GitHub** → if the server clones over SSH, delete the repo **deploy key**
      (repo → Settings → Deploy keys), and remove the private key from
      `~/.ssh/` on the box.

### 4. Destroy the data
- [ ] **R2:** empty and delete the `timeline-backups` bucket (Cloudflare → R2).
- [ ] **NVMe live data:** remove the app data tree —
      `sudo rm -rf /srv/timeline/media /srv/timeline/backups` and drop the
      Postgres volume (`docker volume rm` the prod db volume, or wipe
      `/srv/timeline/db`). This is the real users' data; make sure it's gone.
- [ ] **On-server secret files:**
      `shred -u ~/TimeLine/.env.prod ~/.config/rclone/rclone.conf` and
      `sudo shred -u /etc/timeline/*.env` (then `sudo rm -rf /etc/timeline`).
- [ ] Optionally wipe the checkout itself: `rm -rf ~/TimeLine`.

### 5. Close / release accounts (optional, once the above is done)
- [ ] **Domain (Cloudflare Registrar):** Cloudflare → **Domain Registration** →
      turn **off auto-renew** so you stop paying; the domain then lapses at the
      end of the paid period. To *keep* the name, **transfer it out** to another
      registrar instead. (Cloudflare-registered domains can't be deleted on
      demand — they either expire or get transferred out.)
- [ ] **DNS records:** while Cloudflare is still the registrar you can't delete
      the `your-timeline.net` zone on its own — it goes away when the domain
      expires or transfers out. To pull the records sooner, delete them
      individually (the A record + the Resend SPF/DKIM records).
- [ ] **Cloudflare account:** only closeable once the domain has expired or moved
      out. Until then, keep it — its only remaining job is holding the domain
      (every project API key and the R2 bucket are already gone from steps 3–4).
- [ ] **Resend / healthchecks.io / GitHub accounts:** close any you created only
      for this project; keep the ones you use elsewhere (their project keys and
      data are already deleted).
- [ ] **GitHub repo:** archive it (read-only, keeps history) or delete it, and
      delete the `timeline-backend` / `timeline-web` GHCR packages.

---

## After teardown — nothing should remain

A quick sanity sweep:

- No systemd timers active: `systemctl list-timers | grep -i timeline` returns nothing.
- No containers: `docker ps` shows no `timeline-*`.
- `https://your-timeline.net` no longer resolves / no longer loads.
- No live keys: every token above shows as deleted in its dashboard.
- No orphaned bills: the only recurring cost was the domain — confirm auto-renew
  is off (see `docs/deploy.md` → "Monthly running cost" for the full cost list).
