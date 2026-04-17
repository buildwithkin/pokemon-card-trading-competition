# Chaos Arena — Pokemon Card AI Trading Competition

Three AI bots. Seven days. Pokemon Mega Evolution cards. Paper trading with sourced reasoning. Made for a Michael Reeves–style video.

Full design doc: `~/.gstack/projects/buildwithkin-pokemon-card-trading-competition/calldelegation-main-design-20260415-150117.md`
Incremental build plan: `~/.claude/plans/elegant-gathering-starfish.md`

## Status

**Milestone 1 — foundation layer.** Scaffold + data layer + seed scripts + test skeleton. No bot logic yet (Milestone 2), no daily-round cycle (Milestone 3), no dashboard (Milestone 4).

## Setup (one-time)

Prereqs: Bun ≥ 1.2, Node ≥ 20. Free-tier Supabase account.

```bash
bun install
```

Create `.env.local` from `.env.example`. For Milestone 1, only Supabase keys are required:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...
```

Run the schema migration by pasting `supabase/migrations/0001_initial_schema.sql` into the Supabase SQL editor:
`https://supabase.com/dashboard/project/_/sql/new` → paste → Run.

## Seed the card pool

```bash
bun run scripts/verify-connection.ts   # confirm Supabase auth works
bun run scripts/verify-schema.ts       # confirm all 18 tables exist
bun run seed:pool                      # ingest Mega Evolution cards + today's prices
bun run seed:limitless                 # seed tournament deck archetypes
bun run seed:history                   # scrape 3-month TCGPlayer price history per card
```

`seed:pool` is idempotent — rerun any time to refresh prices. Uses `POKEMONTCG_API_KEY` if set, free tier otherwise.

`seed:history` is a one-time backfill that scrapes each card's TCGPlayer page in headless Chromium and stores ~90 days of `prices` rows per card (source `tcgplayer_scrape`). ~14 minutes cold, resumable, safe to rerun — already-backfilled cards are skipped. Requires `bunx playwright install chromium` once. Apply migration `0003_card_urls_and_variant.sql` first.

Expected result: ~200 cards across me1 / me2 / me2pt5 / me3, price floor $3, real TCGPlayer data for me1+me2, rarity-estimate synthetic prices for the newer two sets (flagged in the DB as `source='rarity_estimate'`).

## Run tests

```bash
bun test
```

All 20 tests are currently `todo` stubs — filled in during later milestones.

## Dev server

```bash
bun run dev
```

`/` renders the scaffold landing page (black + neon, nothing functional yet).

## Project structure

```
src/
  app/                    # Next.js App Router
    layout.tsx
    page.tsx              # Placeholder landing
    globals.css
  lib/
    supabase/
      admin.ts            # Service-role client (server-only)
    utils.ts              # cn() helper
supabase/
  migrations/
    0001_initial_schema.sql
scripts/
  verify-connection.ts    # env + connection sanity check
  verify-schema.ts        # 18-table probe
  seed-pool.ts            # Layer 1 card + price ingest
  seed-limitless.ts       # tournament deck archetypes
  preview-pool.ts         # read-only pool dump
tests/
  idempotency.test.ts
  cron-manual-race.test.ts
  multi-provider-shape.test.ts
  raffle-determinism.test.ts
  vote-lock-race.test.ts
```

## Three-layer architecture (important)

- **Layer 1** — one-time setup. `scripts/seed-pool.ts` + `scripts/seed-limitless.ts`. Runs once. Populates the `cards`, `prices`, `limitless_decks` tables.
- **Layer 2** — daily price cron. Will refresh `prices` via `/api/cron/refresh-prices` (lands in M3). Zero LLM cost.
- **Layer 3** — bot work. Each round, 3 bots decide buy/sell/pass with sourced reasoning. Only layer that spends LLM money.

Bots never fetch data — they consume snapshots Layer 2 writes. Any deviation from this invariant is a bug.

## Milestone gates

- ✅ M1-A: scaffold + build passes
- ✅ M1-B: schema migration + 18/18 tables
- ✅ M1-C: card pool seeded (207 cards, $3 floor)
- ✅ M1-D: tournament decks seeded + test skeleton
- ⏸️ **M1-GATE**: operator review before M2
- ⏭️ M2: single bot + trade decision + LLM spend validation
- ⏭️ M3: multi-bot daily round (Inngest + concurrency)
- ⏭️ M4: operator dashboard (telemetry only)
