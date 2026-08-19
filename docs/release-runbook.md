# Release runbook: publishing the flows engine train

Scope: the 23 packages with `smthrs.group === "engine"`. The agent-group
packages (`@smthrs/cli`, `@smthrs/control`, and the rest) are a separate release
surface and are not published by `.github/workflows/release.yml`.

Worked example below: `v0.1.0-next.0`, the first private-alpha prerelease. A
version containing `-` publishes to the `next` dist-tag; a plain version
publishes to `latest`.

Rehearse first: [release rehearsal receipt](release-rehearsal.md).

## 0. Owner preconditions

These are decisions and account state, not code. Do them once.

- [x] The `@smthrs` npm org exists (confirmed by the owner, 2026-08-17). Still
      confirm the publishing identity is an owner before the first publish:
      `npm org ls smthrs`
- [ ] No engine name is already taken by someone else. All 23 were unpublished
      (`E404`) when the rehearsal checked on 2026-08-16; re-check before publishing:
      ```sh
      node scripts/pack-release.mjs --names \
        | xargs -n1 -I{} sh -c 'npm view {} name >/dev/null 2>&1 && echo "taken: {}" || echo "free:  {}"'
      ```
- [x] The `LICENSE` copyright holder is confirmed by the owner (2026-08-17):
      MIT, `Copyright (c) 2026 William Cory and the Smithers Flows contributors`,
      accepted as final. This closes the `REVIEW.md` blocker 5 caveat. Every
      tarball ships this file, and a published version is immutable, so changing
      the holder later requires a new version.
- [ ] The GitHub environment `npm-publish` exists on this repository and carries
      the npm credential. The workflow publishes with `--provenance` under
      `id-token: write`, so configure npm **trusted publishing** for
      `smithersai/flows` / `release.yml`. If you use a token instead, set
      `NODE_AUTH_TOKEN` as an environment secret from an automation token with
      publish rights.
- [ ] If the environment has required reviewers, a dry run needs approval too.

## 1. Set the release version

Every engine manifest must equal the tag's version, and the engine packages
depend on each other by exact version, so both move together.

```sh
node scripts/set-release-version.mjs 0.1.0-next.0
pnpm install --lockfile-only
node scripts/set-release-version.mjs --check 0.1.0-next.0
git add packages/*/package.json pnpm-lock.yaml
git commit -m "🔧 chore(release): set every manifest to 0.1.0-next.0

Docs: docs/release-runbook.md"
```

Land that commit on `main` the normal way (pull request, or a direct push if
branch protection allows it). The tag in step 3 must point at it.

## 2. Rehearse without publishing

Locally, executing the workflow's own step bodies:

```sh
node scripts/release-rehearsal.mjs --tag v0.1.0-next.0 --transcript /tmp/rehearsal.json
```

That runs every gate, including `pnpm test` over all workspaces. To rehearse only
the release-specific half, add `--skip "Typecheck all workspaces" --skip "Test all
workspaces" --skip "Lint all workspaces"`.

On GitHub, once `release.yml` with the `workflow_dispatch` trigger is on the
default branch (a dispatch is only offered for workflows present there):

```sh
gh workflow run release.yml --ref main -f releaseTag=v0.1.0-next.0 -f dryRun=true
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

`dryRun` defaults to `true`. The run ends with `Report the skipped publication`,
which prints the exact set, order, version, and dist-tag a real run would use.

## 3. Tag and publish

```sh
git checkout main && git pull
git tag -a v0.1.0-next.0 -m "flows engine 0.1.0-next.0"
git push origin v0.1.0-next.0
gh run watch "$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

The tag push publishes: `DRY_RUN` is false on that path and cannot be overridden.
Publication runs in dependency order and skips any version already on the
registry, so a failed run can be resumed by deleting and re-pushing the same tag
(`git push origin :v0.1.0-next.0` then push it again).

## 4. Verify the published set

```sh
# Every name published at the released version, on the next dist-tag.
for name in $(node scripts/pack-release.mjs --names); do
  echo "$name $(npm view "$name@0.1.0-next.0" version) next=$(npm view "$name" dist-tags.next)"
done

# Provenance attestation is attached.
npm view @smthrs/flows@0.1.0-next.0 --json \
  | node -e 'let s="";process.stdin.on("data",c=>s+=c)
      .on("end",()=>console.log(JSON.parse(s).dist.attestations ?? "NO ATTESTATION"))'

# A consumer outside the repo installs the whole set from the registry and loads it.
repo=$PWD
rm -rf /tmp/flows-verify && mkdir -p /tmp/flows-verify && cd /tmp/flows-verify
npm init -y >/dev/null && npm pkg set type=module
npm install $(node "$repo/scripts/pack-release.mjs" --names | sed 's/$/@0.1.0-next.0/')
for name in $(node "$repo/scripts/pack-release.mjs" --names); do
  node --input-type=module --eval "await import('$name')" && echo "esm ok $name"
  node --eval "require('$name')" && echo "cjs ok $name"
done
```

`@smthrs/platform-bun` declares `@effect/platform-bun` as an optional peer.
Install it in the verification project too, or that one import fails by design.

## Where each piece of this lives

Three mechanisms sit behind this runbook. They are separate on purpose.

**Versioning is native.** `scripts/set-release-version.mjs` is the whole
implementation. It rewrites every `packages/*/package.json` to the release
version and retargets every internal range that named the old one, across
`dependencies`, `devDependencies`, `peerDependencies`, and
`optionalDependencies`. Ranges carrying the `workspace:` or `catalog:`
protocol are left alone, because the package manager resolves those and a
literal rewrite would break them. `--check` reports every stale range by name,
and `.github/workflows/ci.yml` runs it. There is no changesets installation in
this repository and nothing here waits on one.

The asymmetry between the two scripts is deliberate. `set-release-version.mjs`
retargets all four dependency groups across all 45 manifests, while
`pack-release.mjs` publishes only the 23 packages in the `engine` group. The
agent-group packages depend on engine packages by exact version, so a bump that
skipped them would leave the workspace unresolvable after the release commit
lands.

**Ordering stays in `pack-release.mjs`.** The dependency graph over the release
set is not acyclic: `kernel` and `platform-browser` depend on each other, and
`scripts/pack-release.test.mjs` pins that cycle. The ordering therefore enters a
cycle at its alphabetically first member rather than refusing it. Any
replacement must reproduce that rule, along with `assertBuilt`, the
`publicationManifest` export rewrite, and the `--list` and `--names` output this
runbook drives.

**Published manifests are generated, not hand-written.** A package declares its
name, version, and publish entry in `BUILD.ts`, and
`packages/targets/src/PackageJson.ts` derives the rest. `exports` is stated once
and `publishConfig.exports` is generated as its compiled mirror, so the subpath
map is never written twice. Fields the generator does not model (`smthrs`,
`homepage`, `repository`, `bugs`, `tags`, `private`, `bin`) are carried through
from the checked-in manifest verbatim; see `preservedFields` in
`packages/targets/src/PackageJsonTemplate.ts`. `packages/targets/test/PackageJson.test.ts`
regenerates all 45 checked-in manifests and fails on any dropped or changed
field.

## 5. If it goes wrong

npm versions are immutable. Do not try to republish a version.

- Broken publish, under 72 hours old and nobody depends on it:
  `npm unpublish @smthrs/<name>@0.1.0-next.0`
- Otherwise: `npm deprecate @smthrs/<name>@0.1.0-next.0 "superseded by
  0.1.0-next.1"`, then repeat from step 1 with the next version.
- Partial publish (some names landed, the run died): fix, re-push the same tag.
  The publish loop leaves published versions in place and continues.
