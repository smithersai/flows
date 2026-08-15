/** @jsxImportSource smthrs */
import { CodexAgent, ClaudeCodeAgent, createSmithers, Loop, Parallel, Sequence, Task, UI, Worktree } from "smthrs"
import { z } from "zod"

const { Workflow, smithers, outputs } = createSmithers({
  input: z.object({
    carriedFindings: z.string().default(""),
  }),
  foundation: z.object({
    summary: z.string().min(40),
    packagesCreated: z.string().min(10),
    primitivesShipped: z.string().min(10),
    gatesGreen: z.boolean(),
    landedTip: z.string().min(7),
    blocked: z.string().min(2),
  }),
  lane: z.object({
    laneName: z.string().min(2),
    summary: z.string().min(40),
    componentsPorted: z.string().min(5),
    dualTested: z.boolean(),
    webVerbatimSymbols: z.string().min(2),
    tuiFallbacks: z.string().min(2),
    landedTip: z.string().min(7),
    blocked: z.string().min(2),
  }),
  integration: z.object({
    verdict: z.enum(["PASS", "FIX"]),
    summary: z.string().min(40),
    appsUiSuiteGreen: z.boolean(),
    parityGateGreen: z.boolean(),
    noIntrinsicsGateGreen: z.boolean(),
    landedTip: z.string().min(7),
    topFindings: z.string().min(4),
  }),
})

// ~/.codex/config.toml pins gpt-5.6-sol at ultra reasoning effort.
// Lanes need network (pnpm install) and parent-repo .git metadata outside the
// worktree cwd, so workspace-write is not enough.
const codexSol = new CodexAgent({ model: "gpt-5.6-sol", sandbox: "danger-full-access" })
const fable = new ClaudeCodeAgent({ model: "claude-fable-5" })
const porter = [codexSol, fable]

const REPO = "/Users/williamcory/flows/flows"
const VAULT = "/Users/williamcory/flows/docs/specs"
const SOURCE = "/Users/williamcory/smithers/packages/ui"
const STYLEGUIDE = "/Users/williamcory/smithers/packages/ui-styleguide"
const REFERENCE = "/Users/williamcory/flows/reference"

const DESIGN = `
THE DESIGN (authoritative): ${VAULT}/Concepts/Isomorphic Component Library.md
Read it in full before writing code. Also read ${VAULT}/Concepts/Dual Target Rendering.md
and ${VAULT}/Concepts/UI Layer.md. Do not redesign; implement what is written.

THE MECHANISM, ALREADY PROVEN (do not re-litigate, do not deviate):
1. @opentui/react/jsx-runtime is literally
     export { Fragment, jsx, jsxs } from "react/jsx-runtime"
   so the agnostic package compiles ONCE with jsxImportSource "react" and runs
   under BOTH reconcilers unmodified.
2. @opentui/react is a real react-reconciler host: context, hooks, refs,
   portals and error boundaries all work.
3. The agnostic package must never name an intrinsic element. That is the only
   reason this works, because opentui's JSX.IntrinsicElements extends the DOM's
   and the two have incompatible prop types for span/b/i/em/strong/a/input/select.

WORKING PROOF (a Badge rendering to DOM and to a terminal grid from one source):

  // agnostic/contract.ts
  export interface BoxProps {
    readonly direction?: "row" | "column"
    readonly padding?: number
    readonly tone?: "surface" | "accent" | "danger"
    readonly children?: ReactNode
    /** Web-only escape hatch: className, data-*, aria-*, DOM handlers. Ignored off-DOM. */
    readonly web?: Record<string, unknown>
  }
  // Return type is \`any\`: opentui declares JSX.Element = ReactNode, which
  // rejects React's ComponentType (ReactElement is not assignable). This is
  // required, not sloppiness. Document it where you write it.
  export interface Primitives {
    readonly Box: (props: BoxProps) => any
    readonly Text: (props: TextProps) => any
  }

  // agnostic/Badge.tsx -- zero intrinsic elements
  export const Badge = (props: BadgeProps) => {
    const { Box, Text } = usePrimitives()
    return (
      <Box direction="row" padding={1} tone={props.variant} web={props.web}>
        <Text bold>{props.children}</Text>
      </Box>
    )
  }

  // dom provider -- className MERGES, never spreads over the variant class
  const { className, ...rest } = (web ?? {}) as { className?: string }
  <div data-slot="box" className={cn(TONE_CLASS[tone], className)} {...rest}>

  // tui provider -- strings MUST be inside <text>; opentui throws on bare text children
  <box flexDirection={direction} padding={padding}><text fg={fg}>{children}</text></box>

THE TIERS (injection granularity is deliberately not uniform):
- Tier 0 pure logic (~24 files, ~2000 LOC): copy VERBATIM into the agnostic
  package, no injection. status.ts, diff.ts, diff-paginate.ts,
  calendar/dateUtils.ts, vault/wikilinks.ts, vault/graphModel.ts,
  vault/autosaveMachine.ts, time/formatRelativeTime.ts,
  agentic/parseAgentOutput.ts, formatJsonSafe, formatPartialJson,
  internal/safeHref.ts, parseStackTrace, parseOutline.
- Tier 1 primitives (~10): Box, Text, Pressable, TextInput, ScrollArea,
  Divider, Overlay, Spinner, Icon, Measure. Injected. Two implementations.
- Tier 2 composed (~50): written ONCE over tier 1. No injection of their own.
- Tier 3 divergent: per-component injection, two hand-written implementations.
  Dialog, Tooltip, Select, Tabs, MessageScroller, PromptInput, ChatComposer,
  Bubble, Calendar week view, WebPreview, and the five heavy adapters
  (Milkdown MarkdownEditor, xterm Terminal, recharts chart, @pierre/diffs,
  d3-force KnowledgeGraph). Terminal versions degrade to a native opentui
  equivalent (<markdown>, <code>, <diff> exist natively) or a documented
  fallback; a gap gets a ticket, never a silent exception.
`

const COMPAT = `
THE COMPATIBILITY CONTRACT (this is what makes the migration non-breaking):

apps/ui imports exactly 41 symbols across three entry points. For EVERY symbol
in that set the DOM implementation is a NEAR-VERBATIM COPY of the legacy
component: same emitted DOM, same sui-* class names, same data-slot attributes,
same full prop passthrough. Do not "improve" them. Fidelity beats elegance here.

The 41 symbols:
  from "@smthrs/ui":
    Alert, AlertDescription, AlertTitle, ApprovalState (type), Badge, Button,
    ChatComposer, ChatMessage, ChatTranscript, Confirmation,
    ConfirmationAccepted, ConfirmationAction, ConfirmationActions,
    ConfirmationRejected, ConfirmationRequest, Dialog, DialogContent,
    DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState,
    FileTree, Markdown, Marker, Plan, PlanContent, PlanStep, Progress,
    Reasoning, RowButton, Separator, SmithersUiStyles, Spinner, StatusPill,
    Suggestion, SuggestionGroup
  from "@smthrs/ui/adapters/markdown-editor": MarkdownEditor, MarkdownEditorStyles
  from "@smthrs/ui/vault": parseWikilinks, restoreWikilinks

Hard pins that existing apps/ui tests already assert -- breaking any of these
fails the build:
- data-command must survive prop passthrough on every interactive element.
  mainview/commands/parity.test.ts asserts it; ChatShell.test.tsx queries
  '.embedded-pane [data-command="chat"]'.
- Alert must let the caller OVERRIDE role. Wave13Toasts.test.tsx asserts
  role="alert" count 0 and .toast[role="status"] count 2.
- ChatComposer must render a real <textarea> and honour textareaProps
  (autoFocus, onKeyDown). AuthChat.test.tsx reads textarea.placeholder.
- .smithers-transcript className must land on the OUTERMOST transcript node;
  AuthChat.test.tsx asserts its direct-child count.
- SSR-safety: CardFrames.test.tsx renders through react-dom/server
  renderToStaticMarkup, where effects never run. Style injection must stay
  safe there (the legacy useInjectUiCss uses useInsertionEffect and the
  explicit <SmithersUiStyles/> mount is the SSR path). Keep the
  data-smithers-ui dedupe marker identical or styles double-inject.
- 33 library-internal sui-* class names are styled from OUTSIDE by
  apps/ui/src/mainview/styles/*.css through ~55 selectors. They are a de-facto
  public API. Preserve them verbatim. No test covers this, so it is a silent
  regression surface -- be careful.
- tokens.ts must NEVER emit a :root {} block. apps/ui defines --primary,
  --accent and --muted with different semantics and a :root block silently
  recolours every palette.

apps/ui uses bun test + @happy-dom/global-registrator (NOT vitest, NOT RTL).
Its suite must pass UNCHANGED after the swap. Changing an apps/ui test to make
the port pass is a failure, not a fix. The only edits allowed in apps/ui are
the package.json dependency and the import specifiers.
`

const RULES = `
Ground rules (read fully before any tool call):
- Read ${REPO}/CLAUDE.md and ${REPO}/AGENTS.md at the worktree root first and follow them exactly.
- WORKTREE PREFLIGHT -- do this FIRST, before pnpm install or any other command.
  This repo is jj-colocated, and 'git worktree add' here can populate a
  worktree's working copy from the WRONG commit, leaving it silently stale.
  Observed 2026-08-15 on this very workflow: a worktree whose HEAD was
  origin/main had a working copy 15 commits behind, with .npmrc absent, which
  breaks 'pnpm install' and makes every gate result meaningless. Run:
      git status --porcelain
  If any TRACKED file differs from HEAD before you have done any work, the
  checkout is stale. Repair it with:
      git reset --hard HEAD
  That syncs tracked files to HEAD and PRESERVES untracked files, so packages
  or edits left by a previous attempt survive. Then assert, and do not proceed
  until both hold:
      git diff --name-only HEAD    -> empty
      test -e .npmrc               -> exists
  Re-run this check after any git operation that touches the working copy.
- You work in an isolated git worktree. Never checkout, move or merge the main
  branch ref. Commit only on the worktree's current branch. If a previous
  attempt left commits or untracked work in the worktree, CONTINUE from it
  instead of restarting -- check 'git log HEAD --oneline -5' and 'git status'
  before assuming you are starting from scratch.
- Do NOT run 'git merge origin/main' reflexively. The worktree branch is already
  created from the intended base. Merge only if 'git log --oneline HEAD..origin/main'
  actually lists commits you need, and never merge a branch that is BEHIND your
  base -- that silently reverts other people's work.
- This tree is pnpm (packageManager pnpm@11.21.0). Use pnpm only, never npm or
  yarn. Run "pnpm install" at the worktree root before building or testing.
- ${SOURCE} and ${STYLEGUIDE} are the SOURCE library and are READ ONLY. Never
  edit anything under /Users/williamcory/smithers. Copy from it into this repo.
- ${REFERENCE}/ is read-only reference (note: the OUTER flows/reference, not
  ${REPO}/reference, and it is gitignored so it is absent from the worktree).
- Never modify: ${REFERENCE}/, smithers.db*, .smithers/.
- New packages mirror the effect repo's shape exactly, per CLAUDE.md. Copy the
  file layout, exports map, scripts and tooling from ${REPO}/packages/core
  (LICENSE, CHANGELOG.md, README.md, dprint.json, tsconfig.json,
  tsconfig.test.json, eslint.config.js, vitest.config.ts, scripts/build.mjs,
  scripts/circular.mjs, src/index.ts, src/internal/, test/).
- Every new package manifest needs "smthrs": { "group": "agent" }. That keeps it
  off the engine release train, which release.yml validates.
- Package names: @smthrs/ui-next, @smthrs/ui-dom-next, @smthrs/ui-tui-next,
  @smthrs/ui-theme-next. The -next suffix is REQUIRED: @smthrs/ui is already
  published on npm at 0.34.0 by the legacy repo and the bare name would collide.
- Commit style: match git log (emoji conventional commits). Stage with explicit
  file paths only; never "git add -A", "git add .", or "git commit -a".
- Every behaviour change ships with tests in the owning package.
- Do not add a dependency on the legacy "smthrs" package or "@smthrs/ui" from
  any product source. That is the entire point of this work.
`

const TEST_HARNESS = `
DUAL TEST HARNESS (both halves exist and both are verified to work):
- DOM half: happy-dom, matching how apps/ui already tests.
- Terminal half: @opentui/react/test-utils exports
    testRender(node, { width, height }) => Promise<TestRendererSetup>
  and @opentui/core/testing exports createTestRenderer. TestRendererSetup gives
  you: flush(), waitFor(), waitForFrame(), captureCharFrame() -> string,
  captureSpans(), resize(w,h), mockInput (keyboard, KeyCodes) and mockMouse.
  A terminal component test renders, flushes, then asserts on captureCharFrame().
- Every ported component needs BOTH a DOM test and a terminal test, except
  documented web-only symbols which need a DOM test plus a parity-list entry.
`

export default smithers((ctx) => {
  const read = (row: any): any => (row ? (row.row ?? row) : undefined)
  const col = (row: any, camel: string): any => {
    if (!row) return undefined
    const snake = camel.replace(/[A-Z]/g, (m) => "_" + m.toLowerCase())
    return row[camel] ?? row[snake]
  }
  const integrationPassed = () => {
    const r = read(ctx.outputs?.integrate)
    return col(r, "verdict") === "PASS"
  }

  const foundationPrompt = `
You are building the FOUNDATION of an isomorphic React component library in ${REPO}.
Everything else in this workflow depends on what you land, so land it correct and complete.

${DESIGN}
${RULES}
${TEST_HARNESS}

YOUR SCOPE (foundation only -- do NOT port feature components, later lanes do that):

1. packages/ui-theme-next (@smthrs/ui-theme-next). Lift ${STYLEGUIDE} wholesale.
   It is already isomorphic-shaped: plain data plus pure math, zero dependencies.
   Carry over themeRegistry (8 themes x light/dark x 31 raw colour tokens),
   SmithersTheme / ThemeVariantTokens / TerminalPalette / ThemeSyntaxId types,
   mixColors (the JS equivalent of CSS color-mix in srgb), contrastRatio, and
   the CSS string emitters (serializeThemeVariant, paletteThemeCss,
   standaloneThemeCss, workflowUiThemeCss, sharedTokens). TerminalPalette is an
   ANSI-16 record deliberately kept dependency-free for exactly this reuse --
   the terminal provider consumes it directly.

2. packages/ui-next (@smthrs/ui-next). The agnostic package.
   - Dependencies: react as a PEER dependency only. No react-dom. No @opentui/*.
     No radix. No clsx-dependent rendering. If it imports react-dom or opentui,
     the design has failed.
   - The primitive contract and the registry/provider (usePrimitives,
     UiProvider), exactly as in the proven spike above.
   - The semantic token contract: token NAMES are the shared vocabulary; values
     are resolved per target. Do not put var() strings here.
   - Tier 0 pure logic copied verbatim (list above), with its tests.
   - jsxImportSource "react" in its tsconfig.

3. packages/ui-dom-next (@smthrs/ui-dom-next). The react-dom provider.
   - Tier 1 primitives as DOM implementations, with the className MERGE fix and
     full prop passthrough (className, style, data-*, aria-*, role, tabIndex,
     autoFocus, disabled, DOM handlers) spread onto the host element.
   - The web token layer: the var(--x, fallback) strings from ${SOURCE}/src/tokens.ts,
     the uiCss.ts sheet, the SmithersUiStyles / useInjectUiCss injection path
     with the data-smithers-ui dedupe marker preserved byte-identical.

4. packages/ui-tui-next (@smthrs/ui-tui-next). The @opentui/react provider.
   - Tier 1 primitives as opentui implementations. Remember: strings must be
     inside <text>, there is no onClick (synthesize from onMouseDown/onMouseUp),
     there is no :hover (hover is React state), and there is no focus manager.
   - jsxImportSource "@opentui/react" in its tsconfig.
   - Ship the FOCUS MANAGER here. opentui has no tab order, no tabIndex, no
     focus trap and no roving-tabindex primitive; \`focused\` is a declarative
     boolean with no arbitration, so a single owner of "what is focused" is
     required. Every keyboard-navigable composite in later lanes depends on it,
     so it must exist now, with tests.
   - Map semantic tokens to terminal values via @smthrs/ui-theme-next
     (TerminalPalette plus mixColors for tints). Radii and shadows collapse to
     border styles or no-ops; opentui borders are the four preset glyph sets.

5. THE GATES, wired into the packages' own check/lint/test scripts:
   - No-intrinsics lint rule on packages/ui-next: fail on any lowercase JSX
     element name anywhere in its src. This is the load-bearing invariant.
   - Export parity test: every symbol exported by @smthrs/ui-next resolves in
     BOTH providers, or appears in an explicit web-only allowlist with a
     written reason. Model it on the existing barrel-surface test in
     packages/flows/test/index.test.ts, which derives its surface from
     dependencies rather than hardcoding.
   - Dual render smoke test proving one agnostic component renders under both
     providers (port the Badge proof above).
   - SSR-safety test through react-dom/server renderToStaticMarkup.

6. Wire the four packages into pnpm-workspace (packages/* already globs) and
   make the root gates pass: pnpm run check, pnpm test, pnpm run lint,
   pnpm run circular, pnpm run browser.

Report packagesCreated (names + one line each), primitivesShipped (the tier 1
list with both implementations noted), gatesGreen (all six root gates actually
run and green -- run them, do not assume), landedTip (the exact commit hash you
landed on this worktree's branch) and blocked ("none" if nothing is blocked).
${ctx.input.carriedFindings ? `\nFindings carried from a previous run that you must fix first:\n${ctx.input.carriedFindings}\n` : ""}
`

  const lanePrompt = (lane: string, dirs: string, compatSymbols: string, notes: string) => `
You are porting ONE LANE of the legacy component library into the isomorphic
library in ${REPO}. The foundation packages already exist on origin/main --
fetch and merge before you start, and build on them. Do not recreate them.

LANE: ${lane}
SOURCE DIRECTORIES (read only, under ${SOURCE}/src): ${dirs}

${DESIGN}
${COMPAT}
${RULES}
${TEST_HARNESS}

HOW TO PORT EACH COMPONENT:
1. Read the legacy component in full at ${SOURCE}/src/<path>.
2. Classify it into a tier. Most of this lane is tier 2: "React + clsx only,
   no radix, no browser API" -- those are written ONCE in @smthrs/ui-next over
   the injected primitives and need no second implementation.
3. If it is in the 41-symbol compatibility set, its DOM implementation is a
   near-verbatim copy in @smthrs/ui-dom-next: same DOM, same sui-* classes,
   same data-slot, same passthrough. Its terminal implementation is written
   fresh in @smthrs/ui-tui-next.
4. If it is tier 3 (divergent), write two implementations and register it
   per-component rather than forcing a shared prop type. A union of DOM and
   terminal props where half are no-ops on each target is WORSE than two files,
   because the no-ops are invisible. Prefer two files.
5. Pure helpers co-located with components (parseStackTrace, parseOutline,
   safeMarkdownHref, toolCallStatus, planStepStatus, approvalStateToStatus,
   testCaseStatusToStatus, sandboxStateToStatus, contextUsagePercent) move to
   the agnostic package as tier 0 and keep their tests.
6. Write BOTH tests per component. Terminal tests assert on captureCharFrame().
7. Export from the lane's barrel section. Never hand-edit another lane's files.

COMPATIBILITY SYMBOLS OWNED BY THIS LANE (DOM must be verbatim): ${compatSymbols}

LANE NOTES: ${notes}

Land your work as commits on this worktree's branch. Run the owning packages'
check, lint and test scripts and make them green before you finish; if the root
gates are broken by another lane's in-flight work, gate on your own packages and
say so in blocked.

Report laneName, summary, componentsPorted (names, grouped by tier),
dualTested (true only if every component you ported has BOTH a DOM and a
terminal test that actually run), webVerbatimSymbols (which compat symbols you
copied verbatim), tuiFallbacks (every place the terminal degrades, and the
ticket you filed for it, or "none"), landedTip (exact commit hash) and blocked.
`

  const integratePrompt = `
You are the INTEGRATION and VERIFICATION step for the isomorphic component
library port in ${REPO}.

${DESIGN}
${COMPAT}
${RULES}
${TEST_HARNESS}

YOUR SCOPE:
1. Fetch and merge every lane branch (iso-ui/*) plus origin/main into this
   worktree. Resolve conflicts keeping both intents. Regenerate any barrel that
   lanes appended to rather than hand-merging it.
2. Swap apps/ui onto the in-repo library. This is the whole point of the work:
   - Remove "@smthrs/ui": "0.33.0" from apps/ui/package.json. It is the ONLY
     registry-resolved @smthrs/* dependency in the workspace; every other one
     is a workspace link. Replace it with workspace deps on @smthrs/ui-next and
     @smthrs/ui-dom-next.
   - Rewrite the import specifiers in the 13 importing files under
     apps/ui/src/mainview. Mount the DOM provider once at the app root in
     App.tsx, next to the existing <SmithersUiStyles /> mount.
   - Change NOTHING ELSE in apps/ui. Do not edit its tests. Do not edit its CSS.
     If a test fails, the port is wrong -- fix the library, not the test.
   - Run: cd apps/ui && bun test src. It must be green.
3. Adopt the library in apps/tui as the terminal proof:
   - Mount the terminal provider in apps/tui/src/index.tsx.
   - Replace at least the hand-rolled Transcript and Composer chrome with
     library components, keeping the existing store-as-single-source
     architecture (components stay pure projections via useSyncExternalStore).
   - Extract apps/tui's inline Tokyo Night hex literals (#7aa2f7 accent,
     #565f89 muted, #9ece6a tool, #bb9af7 card, #e0af68 warn) into
     @smthrs/ui-theme-next instead of leaving them scattered across files.
   - Keep apps/tui's remount-key workaround for opentui's stateful
     InputRenderable; it is a real constraint, not a bug.
   - Run: cd apps/tui && bun test src, and bun run typecheck.
4. Run every root gate and report honestly: pnpm run check, pnpm test,
   pnpm run lint, pnpm run circular, pnpm run browser.
5. Verify the three architecture gates specifically:
   - no-intrinsics lint on packages/ui-next
   - export parity between the two providers
   - SSR-safety through renderToStaticMarkup
6. Confirm no product source imports the legacy library: grep for a bare
   "smthrs" or "@smthrs/ui" import anywhere outside .smithers/ directories.
   It must return nothing.

VERDICT DISCIPLINE:
- verdict PASS only if apps/ui's suite is green UNCHANGED, apps/tui builds and
  tests green, all root gates pass, and all three architecture gates pass.
- FIX otherwise. topFindings must be numbered, priority-ordered and concrete:
  file:line, the defect, and what to change. Those findings are carried into the
  next iteration, so make them actionable.
- Do not ratchet: do not re-open a finding a previous round fixed properly.
- Report appsUiSuiteGreen, parityGateGreen and noIntrinsicsGateGreen as the
  actual observed results of commands you ran, never as assumptions.
`

  const LANES = [
    { id: "laneChat", name: "chat", dirs: "chat/ (14 files, 2599 LOC)",
      compat: "ChatComposer, ChatMessage, ChatTranscript, Marker",
      notes: "MessageScroller is 1115 LOC of IntersectionObserver + ResizeObserver + getBoundingClientRect pixel scroll anchoring -- it is tier 3 and the terminal version is a fresh implementation over <scrollbox stickyScroll stickyStart=\"bottom\">, which apps/tui already uses. Bubble uses ResizeObserver to decide whether the expand affordance shows; the terminal equivalent measures in rows. ChatComposer autogrows a textarea by writing element.style.height -- terminal uses opentui <textarea>." },
    { id: "laneAgentic", name: "agentic", dirs: "agentic/ (22 files, 3409 LOC)",
      compat: "Plan, PlanContent, PlanStep, Reasoning, Suggestion, SuggestionGroup",
      notes: "This is the largest lane but almost all of it is tier 2 (context + useId + useState only, no browser API). InlineCitation is the exception: radix Tooltip plus window.setTimeout hover delay. parseAgentOutput, formatJsonSafe and formatPartialJson are tier 0. apps/ui hand-writes className=\"sui-plan-steps\" on its own <ol> inside PlanContent -- that class must keep working." },
    { id: "laneArtifacts", name: "artifacts+approvals", dirs: "artifacts/ (11 files, 1534 LOC), approvals/ (4 files, 750 LOC)",
      compat: "Confirmation, ConfirmationAccepted, ConfirmationAction, ConfirmationActions, ConfirmationRejected, ConfirmationRequest, ApprovalState (type)",
      notes: "ApprovalState must include at least \"requested\" | \"approved\" | \"denied\" | \"failed-submission\"; apps/ui assigns to it directly. apps/ui hand-writes sui-approval-summary and sui-approval-actions-list. TestResults pulls radix Progress; Artifact and Checkpoint pull radix Tooltip. parseStackTrace is tier 0." },
    { id: "laneAgents", name: "agents+sandbox", dirs: "agents/ (6 files, 1098 LOC), sandbox/ (4 files, 774 LOC)",
      compat: "none",
      notes: "ModelSelector is built on radix Select, which in the terminal is opentui <select> -- but note opentui's select is an always-open scrolling list, NOT a collapsed dropdown, so the interaction genuinely differs and only the data contract is shared. WebPreview renders a real <iframe> and has no terminal equivalent: make it web-only, add it to the parity allowlist with a reason, and file a ticket. ContextUsage and AgentDefinition are tier 2." },
    { id: "laneVault", name: "vault+time", dirs: "vault/ (11 files, 1201 LOC), time/ (3 files, 106 LOC)",
      compat: "parseWikilinks, restoreWikilinks (from the ./vault entry point)",
      notes: "Mostly tier 0 and the highest-value easy win: wikilinks, graphModel, autosaveMachine and formatRelativeTime are all pure and DOM-free by design. KnowledgeGraph is tier 3 (SVG + lazy d3-force + drag pan/zoom) -- terminal gets the documented hub-list fallback that already exists in the source. RelativeTime uses a shared ref-counted 1s tick store and works unchanged under both reconcilers." },
    { id: "laneCalendar", name: "calendar+canvas", dirs: "calendar/ (5 files, 973 LOC), canvas/ (2 files, 442 LOC)",
      compat: "none",
      notes: "dateUtils.ts is tier 0, pure epoch-ms math, zero deps. Calendar's month and agenda views are tier 2; the WEEK view is tier 3 because it converts pixels to time via getBoundingClientRect and clientY. WorkflowCanvas is deliberately renderer-neutral chrome already (it excludes @xyflow/react on purpose) but uses a document.activeElement roving-tabindex toolbar -- route that through the terminal focus manager the foundation shipped." },
    { id: "lanePrompt", name: "prompt+primitives", dirs: "prompt/ (2 files, 899 LOC), primitives/ (2 files, 613 LOC), and the root-level shadcn files",
      compat: "Alert, AlertDescription, AlertTitle, Badge, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, EmptyState, FileTree, Markdown, Progress, RowButton, Separator, SmithersUiStyles, Spinner, StatusPill",
      notes: "This lane owns the most compatibility symbols -- be maximally conservative on the DOM side. The root files are alert, badge, button, card, collapsible-panel, dialog, diff-hunks, empty-state, file-tree, input, kpi-stat, label, progress, row-button, section-header, select, separator, skeleton, spinner, stage-strip, status-pill, styles, table, tabs, tooltip. Button and Badge use radix Slot only for asChild and it is trivially droppable in the terminal. Dialog/Tooltip/Select/Tabs are tier 3: in the terminal build them as absolute + zIndex siblings (opentui supports position absolute, top/right/bottom/left and a real z-sorted child list), NOT as portals -- opentui portals cannot escape the Yoga tree. Markdown is a dependency-free renderer emitting real React elements (no dangerouslySetInnerHTML) so it ports cleanly; the terminal may instead use opentui's native <markdown>. CodeBlock can use opentui's native <code>. PromptInput is 836 LOC with File/FormEvent in its public signature: tier 3, terminal version drops attachments and files a ticket." },
    { id: "laneAdapters", name: "adapters", dirs: "adapters/ (7 files, 1351 LOC)",
      compat: "MarkdownEditor, MarkdownEditorStyles",
      notes: "All five are heavy web-only wrappers. MarkdownEditor (Milkdown/Crepe/ProseMirror) is a compat symbol so its DOM half must be verbatim, including the existing textarea fallback that sniffs happy-dom/jsdom/Bun in the user agent -- that fallback is the precedent for the terminal implementation, which is an opentui <textarea>. apps/ui CSS reaches into .sui-markdown-editor .milkdown .ProseMirror, so the class chain must survive. Terminal: chart has no equivalent (web-only + ticket), Terminal (xterm) becomes native opentui, pierre-diff-view becomes opentui's native <diff> which supports unified and split views. Keep every adapter behind its own subpath export, out of the base barrel, exactly as the source does." },
  ]

  return (
    <Workflow name="iso-ui-port">
      <UI entry="../ui/iso-ui-port.tsx" />
      <Loop until={integrationPassed} maxIterations={4} onMaxReached="return-last">
        <Sequence>
          <Worktree id="foundationWt" path=".smithers/workflows/.worktrees/iso-foundation" branch="iso-ui/foundation">
            <Task id="foundation" agent={porter} output={outputs.foundation} retries={2}>
              {foundationPrompt}
            </Task>
          </Worktree>
          <Parallel maxConcurrency={4}>
            {LANES.map((lane) => (
              <Worktree
                key={lane.id}
                id={`${lane.id}Wt`}
                path={`.smithers/workflows/.worktrees/iso-${lane.name.replace(/[^a-z]/g, "")}`}
                branch={`iso-ui/${lane.name.replace(/[^a-z]/g, "")}`}
              >
                <Task id={lane.id} agent={porter} output={outputs.lane} retries={2}>
                  {lanePrompt(lane.name, lane.dirs, lane.compat, lane.notes)}
                </Task>
              </Worktree>
            ))}
          </Parallel>
          <Worktree id="integrateWt" path=".smithers/workflows/.worktrees/iso-integrate" branch="iso-ui/integrate">
            <Task id="integrate" agent={[codexSol, fable]} output={outputs.integration} retries={2}>
              {integratePrompt}
            </Task>
          </Worktree>
        </Sequence>
      </Loop>
    </Workflow>
  )
})
