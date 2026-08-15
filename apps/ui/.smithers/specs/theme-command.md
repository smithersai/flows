# /theme palette command for the mvp UI

## Goal

Give the mvp UI selectable color themes with a `/theme` command, orthogonal to the existing light/dark toggle. Nine palettes: the eight-theme house suite plus the current paper look preserved as `paper`. Default becomes `night-owl`. Light/dark toggling keeps working exactly as today on its own axis.

## Current facts (verified; skip rediscovery)

- `src/mainview/styles/tokens.css` defines the full custom-property contract: `:root` (light) and `:root[data-theme="dark"]` (dark). It contains the paper/water/sediment palette, mvp-only tokens (`--bubble-*`, `--confluence-*`, `--golden-border`), and the `@smthrs/ui` bridge blocks (color-mix tints, geometry, legacy aliases). The bridge blocks derive from the semantic tokens and are theme-invariant; only the semantic palette values change per theme.
- Commands: `src/mainview/commands/registry.ts` is the pure metadata/filtering half (tested by `registry.test.ts` and `parity.test.ts`); `Commands.ts` binds execution. Existing entries: `{ name: "theme", summary: "Toggle light and dark theme", trigger: "user", execute: () => actions.toggleTheme() }` and a hidden alias `{ name: "dark-mode", aliasOf: "theme", hidden: true }`.
- `App.tsx` stamps `data-theme`. Find the zustand store that owns `toggleTheme` and its persistence and follow that exact pattern. House rule: zustand-only state, no `useState`/`useEffect`.
- The working tree carries pre-existing uncommitted WIP in `App.tsx`, `ChatCards.tsx`, `styles/cards.css`, `styles/chat.css`, `commands/parity.test.ts`, `state/CardFrames.test.tsx`. Do not revert or rework those hunks; edit around them.

## Design contract

### 1. Palettes in tokens.css

Restructure `tokens.css` so `:root` and `:root[data-theme="dark"]` hold the `night-owl` palette (new default), and each non-default palette K gets `:root[data-palette="K"]` and `:root[data-palette="K"][data-theme="dark"]` blocks overriding only the semantic palette values (bg, text ramp, surfaces, borders, hover, inverse, code, brand, status, shadows, bubbles, confluence). Keep the geometry/type/bridge sections single and shared. Palette keys: `night-owl` (default), `paper`, `fucory`, `one`, `github`, `catppuccin`, `solarized`, `gruvbox`, `rose-pine`.

- `paper`: today's values verbatim, both variants, including the bubble and confluence tokens.
- `fucory`: the smithers zinc house palette. Light: bg `#fafafa`, text `#18181b`, text-muted `#52525b`, text-faint `#6d6d75`, text-placeholder `#8a8a93`, surface `#ffffff`, surface-2 `#f4f4f5`, surface-3 `#ffffff`, glass `rgba(255,255,255,0.72)`/`0.85`, border `rgba(24,24,27,0.08)`, border-strong `rgba(24,24,27,0.14)`, border-solid `#e4e4e7`, hover `#f4f4f5`, hover-subtle `rgba(24,24,27,0.04)`, inverse `#18181b`/`#fafafa`, code `#18181b` bg / `#f4f4f5` text, inline-code `rgba(24,24,27,0.06)`, brand `#6d56d8`, success `#087461`, danger `#c5343f`, warning `#916000`, info `#2a63c9`, shadow-rgb `24 24 27`. Dark: bg `#09090b`, text `#f4f4f5`, muted `#a1a1aa`, faint `#8c8c95`, placeholder `#75757e`, surface `#141417`, surface-2 `#1b1b20`, surface-3 `#232329`, glass `rgba(20,20,23,0.72)`/`0.85`, border `rgba(255,255,255,0.09)`/`0.16`, border-solid `#2a2a30`, hover `#1f1f24`, hover-subtle `rgba(255,255,255,0.05)`, inverse `#f4f4f5`/`#18181b`, code `#0c0c0e`/`#e4e4e7`, inline-code `rgba(255,255,255,0.08)`, brand `#8b78e6`, success `#2ec9a8`, danger `#f2555a`, warning `#e0a23a`, info `#6aa5f8`, shadow-rgb `0 0 0`.
- `night-owl`: dark from Night Owl (bg `#011627`, text `#d6deeb`, selection/hover family around `#1d3b53`, brand `#c792ea`, info `#82aaff`, success `#addb67`, danger `#ef5350`, warning from `#ecc48d` adjusted for badge contrast); light from Night Owl Light (bg `#FBFBFB`, text `#403f53`, chrome `#F0F0F0`, hover/selection `#E0E0E0`, brand `#994cc3`, info `#4876d6`, success derived from `#2AA298` darkened until small text on its soft tint reaches >= 4.5:1, danger from `#E64D49` darkened likewise, warning from `#daaa01` darkened heavily likewise). Code tokens are the literal editor colors per variant.
- The remaining six: derive from the upstream VS Code theme JSONs. On this machine they are readable at `/Users/williamcory/smithers/node_modules/.pnpm/@shikijs+themes@3.23.0/node_modules/@shikijs/themes/dist/<id>.mjs` (each exports frozen JSON with a workbench `colors` map). Pairs: one = `one-dark-pro`/`one-light`, github = `github-dark`/`github-light`, catppuccin = `catppuccin-mocha`/`catppuccin-latte`, solarized = `solarized-dark`/`solarized-light`, gruvbox = `gruvbox-dark-medium`/`gruvbox-light-medium`, rose-pine = `rose-pine`/`rose-pine-dawn`. Derivation: bg/text from editor colors, surface ramp and borders synthesized the same way the existing palettes step them, brand from the theme's signature accent, status colors from its error/warning colors with the same >= 4.5:1 contrast rule for light variants. The output is static hex values checked into tokens.css; no runtime or build dependency on those files.
- Bubble and confluence tokens: express as color-mix recipes over the semantic tokens (for example, outgoing bubble as a brand tint over surface, incoming as surface/hover family, meta text as muted) so every palette gets sensible values automatically; keep `paper`'s current literal values as its override, and hand-tune `night-owl`'s (dark incoming near `#1d3b53`).

### 2. The /theme command

- Repurpose `{ name: "theme" }`: it becomes the palette command. `acceptsArgs: true`, args spec naming the nine keys, summary like "Set the color theme". `/theme <key>` sets the palette; unknown key produces the app's normal command feedback listing valid keys; `/theme` with no argument surfaces the list with the current palette marked, using whatever feedback mechanism existing arg-taking commands use (follow app conventions; if there is no list mechanism, cycling through palettes with feedback is acceptable).
- Promote `dark-mode` to the canonical light/dark toggle: unhidden, own summary, `execute: () => actions.toggleTheme()`. It must no longer alias the repurposed `theme`. Keep `trigger: "user"` semantics for both.
- Update `registry.test.ts` and `parity.test.ts` accordingly (parity covers the user/agent trigger axis; keep both commands `trigger: "user"`).

### 3. State

- Palette lives in the same zustand store as the light/dark theme, persisted the same way, default `"night-owl"`. `App.tsx` stamps `data-palette` on the root element alongside `data-theme` (omit the attribute or set it explicitly for the default; either way the CSS default must be night-owl). Zustand-only; DOM sync follows the store's existing pattern for `data-theme`.

### 4. Tests

- Registry and parity tests updated and green.
- Store tests for the palette action and persistence, following the existing store test patterns.
- A tokens.css structural test if the suite has CSS tests (check existing conventions near `CardFrames.test.tsx`); otherwise assert via the store/DOM tests that each palette key round-trips into the attribute.
- Full `bun test` and typecheck green. Never weaken an existing assertion to get green; report blockers instead.

## Constraints

- No new dependencies.
- Match the repo's formatting (tabs in CSS/TS as present) and file conventions.
- Do not touch the unrelated WIP hunks in the files listed above beyond what your feature requires.
- DO NOT COMMIT. Leave all changes in the working tree. The tree carries foreign WIP in files you must edit, so any commit would sweep it. Instead, end with a concise summary listing every file you changed and what changed in each.
- If genuinely blocked or facing an ambiguous destructive choice, use `smithers ask-human`; never guess.

## Definition of done

- `/theme <key>` switches between all nine palettes live, `/theme` with no arg surfaces the list, `dark-mode` toggles light/dark independently, and the default look is Night Owl (dark variant under a dark scheme, Night Owl Light under light).
- All tests and typecheck green via `bun test` (scoped to the app's usual test entry points).
- Changes left uncommitted with a written summary of touched files.
