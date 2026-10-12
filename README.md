# Vendora

**The voice-first business assistant and vendor network built for Nigerian traders.**
*The trader doesn't manage data. Vendora does.*

Traders record sales, restock, track money owed, issue invoices and see how business is going by
talking (or typing) to Vendora in English or Pidgin, and find suppliers and customers in the
Vendors Hub. Web app (installable PWA), React + TypeScript + Vite, backed by Supabase. Spoken
replies use YarnGPT through a server-side function.

---

## What works today — verification matrix

Status words mean exactly this:
**Integration-verified** = exercised end-to-end over HTTP against Supabase Auth + PostgREST + PostgreSQL with the real migrations ·
**Locally verified** = tested in a browser or against PostgreSQL, but not over the full Supabase stack ·
**Mocked** = tested against a mocked provider ·
**Implemented, not verified** = code exists, never run against the real service ·
**Not deployed** = nothing is live yet.

| Feature | Status | Evidence |
|---|---|---|
| Sign up (2 steps), sign in, sign out, wrong-password message | Integration-verified | `live.cjs` browser walkthrough (local Supabase Auth v2.177.0) |
| Profile created at signup by DB trigger; `ensure_profile()` recovery | Integration-verified | `live.integration.test.ts`, `rls_and_rpcs.test.sql` §1 |
| Duplicate email refused | Integration-verified | `live.integration.test.ts` |
| Email confirmation, password-reset emails | Implemented, not verified | Local stack auto-confirms; no SMTP was available |
| Onboarding (business → products → voice intro), resumable | Integration-verified | browser walkthrough |
| Products, restock, stock correction, movement ledger | Integration-verified | live tests + DB tests §3, §10 |
| Sales: atomic, idempotent (no double-recording on retry), stock checks | Integration-verified | live tests, DB tests §5–6, browser POS + chat |
| Credit sales, debts, payments, overpayment blocked | Integration-verified | live tests, DB tests §7, browser |
| Sale reversal (history kept, stock restored, invoice voided) | Integration-verified | live tests, DB tests §9 |
| Invoices: gap-free numbers, print / save as PDF, share | Numbers integration-verified; print/share UI locally verified | live tests, browser |
| Dashboard & Insights from real records (Lagos days) | Integration-verified | live tests, DB tests §11, browser |
| Row Level Security: cross-business isolation, roles, anon lockout | Integration-verified | live tests + 18 DB test sections |
| Payments can't be self-marked "verified" | Integration-verified | live tests, DB tests §12 |
| Voice assistant (parse → confirm → execute → reply from server result) | Locally verified | 60 parser & dialog tests; browser chat in demo **and** live mode |
| Speech-to-text (browser Web Speech API) | Implemented, not verified | Headless browser has no microphone; needs a phone test |
| YarnGPT spoken replies (Edge Function `tts`) | Mocked | Adapter tested against the documented contract; **no API key was available** |
| Vendors Hub: profiles, adverts, search & filters, feed, connections, blocking | Integration-verified (data); browser-verified (advert publish, search, feed) | live tests + DB tests §14–17 |
| Messaging between two vendors (persisted, idempotent) | Integration-verified | live tests (two real accounts) |
| Realtime message delivery | Implemented, not verified | Local stack has no Realtime; app falls back to 15-second polling and says so |
| Photo/video uploads (Supabase Storage, with progress) | Implemented, not verified | Storage policies DB-tested; uploads need a real Storage service |
| Vendor verification (admin-only approval) | Integration-verified (DB) | DB tests §17 — admin review UI not built; admins use SQL/RPC |
| Offline: sales queued on the phone, synced idempotently | Locally verified | `queue.test.ts` (incl. "server saved but reply lost") |
| App shell offline (service worker), installable | Implemented, not verified on device | — |
| Accessibility | Locally verified (automated) | axe-core WCAG 2.x A/AA: 0 violations on 11 screens; manual screen-reader testing not done |
| Bank-feed transfer detection, receipt fraud check (shown in Figma) | **Not implemented** | Needs a bank partner integration; UI says so plainly |
| Production deployment | **Not deployed** | Needs your Supabase project + GitHub Pages enabled (see below) |

---

## Quick start (demo, no backend)

```bash
npm install
npm run dev          # open the printed URL, choose "Try the demo shop"
```

Without Supabase credentials the app runs as a clearly-labelled **demo shop**: sample data kept in
that browser tab only, never mixed with real accounts. The Vendors Hub is disabled in the demo
because it involves real people.

## Connect your Supabase project

1. **Create a project** at supabase.com.
2. **Apply the migrations** (in order) — with the Supabase CLI:
   ```bash
   supabase link --project-ref YOUR-REF
   supabase db push
   ```
   or paste each file in `supabase/migrations/` into the SQL editor in filename order.
3. **Auth settings** (Dashboard → Authentication):
   - Email provider on. Keep "Confirm email" on for production; configure SMTP so emails send.
   - *Site URL*: `https://devemmy.github.io/VENDORA/`
   - *Redirect URLs*: `https://devemmy.github.io/VENDORA/**` and `http://localhost:5173/**`
4. **Realtime**: the migration adds `messages`, `notifications` and `conversation_participants` to the
   `supabase_realtime` publication. Check they're listed under Database → Publications.
5. **Frontend env** — copy `.env.example` to `.env.local` and fill in the **public** URL and anon/publishable key.
6. **Admins** — to review vendor verification requests, add your user id:
   `insert into public.app_admins (user_id) values ('<your-auth-user-id>');`
   then call `select public.review_verification('<request-id>', true, 'CAC checked');`.

### YarnGPT voice (server-side only)

YarnGPT provides **text-to-speech only** (no speech-to-text). Vendora calls it from the `tts` Edge
Function so the key never reaches the browser.

```bash
supabase functions deploy tts
supabase secrets set YARNGPT_API_KEY=sk_live_xxx.yyy
# optional
supabase secrets set YARNGPT_DEFAULT_VOICE=<name from GET /api/v1/voices> YARNGPT_DAILY_LIMIT_PER_USER=60
```

Contract used (checked against yarngpt.ai docs on 2026-10-12): `POST https://yarngpt.ai/api/v1/streaming/conversation`
with `{ text, voice?, output_format: "mp3", target_language? }`, `Authorization: Bearer <key>`.
- English and Pidgin replies are spoken as written.
- For Yoruba, Igbo and Hausa the function sends `target_language` — YarnGPT **translates** the
  English reply before speaking. The on-screen text stays in English so figures can be checked.
  Translation quality has not been verified.
- If the key is missing, the quota is used up, or the call fails, the reply still shows as text and
  the device voice is used where available. Users see why.
- Per-user daily cap is enforced in the database (`consume_tts_quota`, service role only).

Speech **recognition** uses the browser's Web Speech API (Chrome/Edge on Android and desktop).
English/Pidgin use the `en-NG` locale. Yoruba/Igbo/Hausa locales are requested but marked
experimental in the UI; the transcript is always shown and editable, and nothing is saved without
an explicit confirmation.

## Deploy (GitHub Pages)

`.github/workflows/deploy.yml` lints, type-checks, runs unit and database tests, then builds and
deploys `dist/` to GitHub Pages on every push to `main`.

1. Repo → Settings → Pages → Source: **GitHub Actions**.
2. Repo → Settings → Secrets → Actions: add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`
   (public values only). Without them the site deploys as the demo.

GitHub Pages only serves static files. Everything privileged runs in Supabase (RLS, RPCs) and in
the `tts` Edge Function. Never put a service-role key or the YarnGPT key in `VITE_*` variables.

## Tests

```bash
npm test             # 72 unit tests: parser, dialog engine, offline queue, mocked YarnGPT adapter
npm run test:db      # migrations + 18 RLS/RPC test sections on a throwaway PostgreSQL (needs PG 15+ binaries)
npm run lint && npm run typecheck && npm run build
```

**Live integration tests** (real supabase-js over HTTP, two signed-up users, no Docker needed):

```bash
scripts/local-stack/start.sh                 # PostgreSQL + Supabase Auth + PostgREST + gateway on :54321
source .local-stack/env.sh
LIVE=1 npx vitest run src/data/live.integration.test.ts
```

The local stack downloads the Supabase Auth and PostgREST release binaries from GitHub once. It does
not include Storage, Realtime or Edge Functions.

## How it's built

```
src/
  assistant/   parser (EN/Pidgin + basic YO/IG/HA counting), dialog engine (confirm before write), executor
  data/        BusinessApi interface → SupabaseBusinessApi (live) | DemoBusinessApi (sample shop); hubApi
  offline/     IndexedDB sale queue + product cache
  voice/       Web Speech recognition, YarnGPT playback, listening overlay, assistant provider
  pages/       screens (auth/, hub/ …) · components/ shared UI · styles/ tokens from the Figma frames
supabase/
  migrations/  schema, RLS, RPCs, hub, storage policies, realtime, TTS quota
  functions/   tts (YarnGPT proxy) + _shared adapter
  tests/       Supabase stub + RLS/RPC test suite
scripts/local-stack/  Docker-free Supabase-compatible stack for integration tests
```

Key rules the code enforces:
- **No success before commit.** Voice replies like "Your sale has been recorded. You have 8 bags
  left." are generated from the database's response, never from what was heard.
- **Every financial write is idempotent** (client operation id) and runs in one database
  transaction inside a `SECURITY DEFINER` function that checks the caller's role.
- **History is never rewritten.** Corrections are reversals and adjustments with reasons.
- **Stock can't be edited directly** — only through restock/adjust/sale functions that write a movement.
- **"Verified" can only come from an admin** (vendors) or a bank integration (payments).
- **Demo data never touches Supabase**, and Supabase failures never fall back to fake data.

Roles: **owner** (everything, team), **manager** (stock, prices, adverts), **assistant** (sales,
payments, customers — can't change prices or stock counts).

## Design

Built from the supplied Figma frames: Welcome, Set up your account, Home, Payment notification,
Listening, Chat, Stock, Sales & Payments, Insights, Receipt verification, Profile. Tokens (colours,
radii, type scale, elevation, motion) live in `src/styles/tokens.css`.

Deliberate differences from the frames, and why:
- **Email is required at signup** (the frame marks it optional): Supabase phone sign-in needs an SMS
  provider that isn't configured. Phone is still collected.
- **Bank card & "Scan receipt to verify fraud"**: shown as "Bank account not linked" and "Upload
  receipt → awaiting review". Vendora can't confirm transfers yet, so it doesn't claim to.
- **Lock-screen payment notification** (frame 4) isn't built: it depends on the bank feed.
- **Insight copy** is computed from records; the frame's example claims ("sales jumped 30% last
  time") are not shown because there is no data behind them.
- **A sixth tab, "Hub"**, was added to the bottom navigation for the Vendors Hub (not in the frames).
- A few greys and greens are slightly darker than the frames to meet WCAG AA contrast.
- Stock rows are ordered out-of-stock → low → in stock so problems are seen first.

## Known limitations

- No bank integration (transfer auto-detection, fraud checks) — the Wema integration is future work.
- YarnGPT, Storage uploads, Realtime and email delivery are untested against real services.
- Voice understanding is rule-based: it covers common sales/stock/debt phrasing in English and Pidgin;
  Yoruba/Igbo/Hausa support is limited to simple phrases and counting words 1–10.
- No admin dashboard for verification review or report moderation (SQL/RPC only).
- Team members must already have an account before an owner adds them (no email invites).
- Offline queue covers sales from the till and voice; restocks and debt payments need a connection.
