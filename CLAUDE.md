# Atlas VTT

Browser VTT: DM builds multi-level 3D scenes; players play in a 2.5D top-down view with lighting,
shadows and line of sight computed from the 3D geometry. Requirements: `docs/SPEC.md`.
Architecture and module contracts: `docs/ARCHITECTURE.md` (read it before changing a module's API).

## Commands

- `npm run dev` — Vite dev server
- `npx tsc -b` — typecheck (must pass; `noUnusedLocals`/`noUnusedParameters` are on)
- `npx vitest run` — unit tests (pure `src/core/**` logic must have tests)
- `npx eslint .` — lint

## Conventions

- 1 world unit = 1 foot, Y up, grid on XZ, 5 ft cells. Object Y values are relative to their level's ground.
- `src/core/**` is pure TypeScript: no DOM, no three.js, no React. It must run in a Worker and in vitest.
- The scene document (`src/core/scene/types.ts`) is versioned JSON. Changing its shape means bumping
  `SCENE_SCHEMA_VERSION` and adding a migration in `src/core/scene/migrations.ts`.
- Import with the `@/` alias (maps to `src/`).
- UI: compose from shadcn components in `src/components/ui` (style `base-mira`, Base UI primitives,
  lucide icons). Add missing ones with `npx shadcn@latest add <name>`; don't hand-roll buttons, menus,
  dialogs, sliders, tooltips, etc. Use theme tokens (`bg-card`, `text-muted-foreground`, …), never raw colours.
  The app is dark-theme first.
- Players must never receive data they cannot see: anything sent to a player goes through
  `src/core/session/filter.ts`. Never trust identity fields in network payloads.
- Match the surrounding code style: no semicolons, double quotes, 2-space indent (Prettier config in repo).

## Git workflow

- There are no live users yet; two developers work on this repo. Commit and push to `master` whenever a
  piece of work is done and `tsc`, `vitest` and `eslint` pass. No need to ask first or open a PR, and no
  feature branches unless a change is risky or unfinished.
- The other developer pushes too: `git pull --rebase` before pushing, and never force-push `master`.
- The repo is public: never commit `.env*` files, `test_maps/` (third-party art) or screenshots of it.
