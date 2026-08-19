# Human tasks: first engine-group alpha publish

The production-readiness panel passed. Complete these owner-only tasks before
the first publish.

## H1. Verify npm control and reserve the engine names

Verify that the publishing identity controls `@smthrs`:

```sh
npm org ls smthrs
```

Reserve or confirm every engine-group name below. All returned E404 at
the audit; recheck each name before publishing:

```sh
npm view @smthrs/canonical name
npm view @smthrs/capability name
npm view @smthrs/crypto name
npm view @smthrs/artifacts name
npm view @smthrs/database name
npm view @smthrs/jj name
npm view @smthrs/journal name
npm view @smthrs/keys name
npm view @smthrs/observability name
npm view @smthrs/plan name
npm view @smthrs/flow name
npm view @smthrs/engine name
npm view @smthrs/run-store name
npm view @smthrs/step-cache name
npm view @smthrs/sync name
npm view @smthrs/kernel name
npm view @smthrs/engine-store name
npm view @smthrs/platform-browser name
npm view @smthrs/platform-bun name
npm view @smthrs/platform-node name
npm view @smthrs/sandbox name
npm view @smthrs/time-travel name
npm view @smthrs/flows name
```

## H2. Confirm the LICENSE copyright holder — DONE

Confirmed by the owner on 2026-08-17: MIT, with `LICENSE:3` reading
`Copyright (c) 2026 William Cory and the Smithers Flows contributors`, accepted
as final. Every engine manifest already declares `"license": "MIT"`. This closes
the `REVIEW.md` blocker 5 caveat. A published version is immutable, so changing
the holder after the first publish requires a new version.

## H3. Run the first actual publish

Push the real `v0.1.0-next.0` tag and run `release.yml` for the first actual
publish. Follow the [release runbook](docs/release-runbook.md) exactly.

## H4. Give final alpha-shippable sign-off

Confirm that the engine group is alpha-shippable, using the
[alpha notes](docs/alpha-notes.md), [release rehearsal](docs/release-rehearsal.md),
and the production-readiness panel's passing verdicts recorded in this run.

# Human tasks: GitHub automation

The automation layer (`factory/automation/`, `.github/workflows/gen.*.yml`) is
landed and inert until these are done. Every one is owner-only.

## H5. Create the label set

The state machine is the labels, so a missing label is a state the automation
cannot enter. Create all seven:

```sh
gh label create 'agent:approved'  --repo smithersai/flows --color 0E8A16 \
  --description 'Maintainer gate. Admits an automation job on this issue or PR.'
gh label create 'repro:verified'  --repo smithersai/flows --color 5319E7 \
  --description 'The PoC fails on main and the reporter confirmed it.'
gh label create 'repro:needs-info' --repo smithersai/flows --color FBCA04 \
  --description 'Targeted questions are posted; awaiting the reporter.'
gh label create 'repro:blocked'   --repo smithersai/flows --color B60205 \
  --description 'Parked on an infra blocker, for reasons unrelated to the report.'
gh label create 'poc:proposed'    --repo smithersai/flows --color C5DEF5 \
  --description 'A proof of concept is posted; awaiting the reporter.'
gh label create 'poc:confirmed'   --repo smithersai/flows --color C5DEF5 \
  --description 'The reporter confirmed the proof of concept captures their issue.'
gh label create 'poc:rejected'    --repo smithersai/flows --color C5DEF5 \
  --description 'The reporter rejected the proof of concept; a revision follows.'
gh label create 'dupe:candidate'  --repo smithersai/flows --color D4C5F9 \
  --description 'A strong duplicate candidate was found; awaiting confirmation.'
gh label create 'infra'           --repo smithersai/flows --color BFD4F2 \
  --description 'An infrastructure blocker. Closing it unparks the reports on it.'
```

## H6. Set the ANTHROPIC_API_KEY Actions secret

Every agent job reads it. It is placed only in trusted, gated jobs; the
renderer refuses to put it in a job marked `untrustedInput`, which is why the
PoC sandbox cannot hold it.

```sh
gh secret set ANTHROPIC_API_KEY --repo smithersai/flows
```

## H7. Decide the environment protection rules

The generated workflows carry no `environment:` binding today. Two decisions,
both reversible:

1. Whether `gen.verified-fix.yml` needs a protected environment. It is the one
   automation that opens a pull request. The `agent:approved` gate already
   requires a maintainer action, so an environment would be a second approval
   on the same decision.
2. Whether to require the `repro-proof` check on pull requests that claim to
   close an issue. The check is advisory until it is added to the branch
   protection rules:

   ```sh
   gh api -X PUT repos/smithersai/flows/branches/main/protection/required_status_checks \
     -f 'checks[][context]=proof'
   ```

Record whichever way you decide in
`docs/specs/Concepts/Github Automation.md` under Open.

## H8. Set FACTORY_PR_TOKEN so the fix lane's pull requests get checks

A pull request opened with the workflow token triggers no workflows, so the
proof gate and the rubric review would never run on the automation's own fix
pull requests. Create a fine-grained PAT (contents: write, pull-requests:
write) or a GitHub App token and store it:

```sh
gh secret set FACTORY_PR_TOKEN --repo smithersai/flows
```

`gen.verified-fix.yml` falls back to the workflow token until the secret
exists; until then, run the checks on those pull requests manually.

## H9. Confirm the `agent:approved` policy with the team

The gate admits `OWNER`, `MEMBER`, and `COLLABORATOR` without a label. Anyone
else needs a maintainer to apply `agent:approved`. If the organization grants
`MEMBER` broadly, narrow the association list in
`packages/targets/src/GithubAutomation.ts` (`trustedAssociations`) and
regenerate every workflow with `smthrs run //:<target>`.
