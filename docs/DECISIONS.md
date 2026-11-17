# Decisions

Earlier product decisions (Race tab, Mods, setups, spotter, brake marks, reports, loader bundling, EVO-native data) are recorded in the README and the commit history. This file records decisions made from the 2026-11-17 audit onward.

## 2026-11-17: Extend the existing stack, no framework migration

- **Decision:** keep vanilla ES modules (no build step), the hand-written Node router and SQLite via `node:sqlite`.
- **Why:** the stack works, ships as a portable zip without a bundler, and the app has 4 runtime dependencies. A React/TypeScript rewrite would put the whole app at risk for no user-visible gain.
- **Rejected:** React + Vite; TypeScript conversion; Express.

## 2026-11-17: Tests with the built-in `node:test`

- **Decision:** `node:test` + `node:assert`, no Jest/Vitest.
- **Why:** zero new dependencies; Node 22 is already required.

## 2026-11-17: One branch per phase, merged locally after approval

- **Decision:** each phase is built on `phase/<id>-<name>`, committed in small steps, deployed to the installed app for review, and merged into local `main` after APPROVE. Push, PR, tag and release only on the user's explicit OK.
- **Why:** the user's feature-branch rule and the CLAUDE.md publishing rules.

## 2026-11-17: Provenance before more analysis

- **Decision:** put data-provenance labelling (P2) ahead of new analysis features.
- **Why:** some current conclusions (balance, tyre windows) depend on unverified shared-memory offsets; the data-integrity rules forbid presenting them as fact.

## 2026-11-17: Open product decisions

- D1 accent/navigation, D2 update mechanism, D3 gamification. See IMPLEMENTATION_ROADMAP.md. Each is asked when its phase starts.
