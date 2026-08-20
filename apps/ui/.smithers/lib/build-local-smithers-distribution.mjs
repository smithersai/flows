import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/*
 * The source tree the distribution is built FROM. Resolution order:
 * SMITHERS_SOURCE_ROOT (an isolated caller states its tree explicitly), then
 * the tree this file lives in (five levels up from .smithers/lib), then the
 * path this script was written against. The hard-coded literal alone made the
 * build unusable on any other machine and un-rerunnable from a moved checkout.
 */
const candidateRoots = [
  process.env.SMITHERS_SOURCE_ROOT,
  resolve(here, "../../../../.."),
  "/Users/williamcory/flows",
].filter((candidate) => candidate !== undefined && candidate !== "");
const sourceRootFor = (relativeRoot) =>
  candidateRoots.find((candidate) => existsSync(join(candidate, relativeRoot, "package.json")));

export const smithersSourceRoot = (() => {
  const probe = "flows/packages/database";
  const found = sourceRootFor(probe);
  if (found === undefined) {
    throw new Error(
      `no smithers source tree holds ${probe}; set SMITHERS_SOURCE_ROOT to the checkout that does`,
    );
  }
  return found;
})();

// Smallest real package closure needed by the MVP authority composition root.
// Keep this ordered from leaves to consumers so the manifest is useful to both
// humans and a future registry publisher.
export const packageRoots = [
  "flows/packages/database",
  "flows/packages/host",
  "flows/packages/journal",
  "flows/packages/keys",
  "flows/packages/kernel",
  "agent/packages/core",
  "agent/packages/model",
  "agent/packages/notifications",
  "agent/packages/registry",
  "agent/packages/control",
  "agent/packages/harness",
  "plugins/packages/adapters",
  "connectors",
];

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

export const publicationManifest = (manifest, dependencySpecs) => {
  if (!isRecord(manifest)) throw new TypeError("package manifest must be an object");
  const isSourceOnlyConnectors = manifest.name === "@smithers/connectors";
  if (isSourceOnlyConnectors) {
    return {
      ...manifest,
      private: false,
      dependencies: {
        "@elizaos/core": manifest.dependencies["@elizaos/core"],
        zod: manifest.dependencies.zod,
      },
      exports: {
        "./package.json": "./package.json",
        "./connectors.manifest.json": "./connectors.manifest.json",
        ".": "./runtime/index.ts",
        "./runtime/*": "./runtime/*.ts",
      },
      files: ["runtime/**/*.ts", "connectors.manifest.json", "README.md"],
    };
  }
  if (!isRecord(manifest.publishConfig) || !isRecord(manifest.publishConfig.exports)) {
    throw new TypeError(`${String(manifest.name ?? "package")} must declare publishConfig.exports`);
  }
  const rewriteDependencies = (dependencies) => Object.fromEntries(
    Object.entries(dependencies ?? {}).map(([name, version]) => {
      if (!name.startsWith("@smithers/")) return [name, version];
      const localSpec = dependencySpecs.get(name);
      if (localSpec === undefined) {
        throw new Error(`${String(manifest.name)} requires ${name}, which is missing from the local distribution closure`);
      }
      return [name, localSpec];
    }),
  );
  const { exports, ...publishConfig } = manifest.publishConfig;
  return {
    ...manifest,
    exports,
    publishConfig,
    dependencies: rewriteDependencies(manifest.dependencies),
  };
};

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
};

const copyFilter = (source) => !source.split("/").some((segment) =>
  segment === "node_modules" || segment === "coverage" || segment === ".smithers" || segment.endsWith(".tsbuildinfo")
);

export const buildDistribution = (destination) => {
  const outputDirectory = resolve(destination);
  mkdirSync(outputDirectory, { recursive: true });
  const packages = packageRoots.map((relativeRoot) => {
    const sourceRoot = join(smithersSourceRoot, relativeRoot);
    const manifest = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
    return { relativeRoot, sourceRoot, manifest };
  });
  const dependencySpecs = new Map(packages.map(({ manifest }) => [
    manifest.name,
    `file:${join(outputDirectory, `${manifest.name.replace("@", "").replace("/", "-")}-${manifest.version}.tgz`)}`,
  ]));
  const stagingRoot = mkdtempSync(join(tmpdir(), "mvp-smithers-pack-"));
  /*
   * Publish is staged, never streamed into the destination: tarballs pack
   * into a sibling staging directory and are RENAMED into place only once
   * every package packed, with manifest.json landing last as the commit
   * marker. A crash mid-build then leaves the previous distribution
   * untouched instead of a half-written one consumers could install.
   */
  const publishRoot = mkdtempSync(join(outputDirectory, ".publish-"));
  const packed = [];
  try {
    for (const entry of packages) {
      const requiredArtifacts = entry.manifest.name === "@smithers/connectors"
        ? []
        : ["dist/esm/index.js", "dist/esm/index.d.ts", "dist/cjs/index.js"];
      if (requiredArtifacts.some((required) => !existsSync(join(entry.sourceRoot, required)))) {
        /*
         * The build runs in the source repo, not the staging copy: the
         * staging copy excludes node_modules, so a staged build could not
         * resolve the workspace's own dependencies. dist/ is each repo's
         * ordinary gitignored build output, so this mutates no source.
         */
        run("npm", ["run", "build"], entry.sourceRoot);
      }
      for (const required of requiredArtifacts) {
        if (!existsSync(join(entry.sourceRoot, required))) throw new Error(`${entry.manifest.name} build did not create ${required}`);
      }
      const stagedRoot = join(stagingRoot, entry.manifest.name.replace("@smithers/", ""));
      cpSync(entry.sourceRoot, stagedRoot, { recursive: true, filter: copyFilter });
      writeFileSync(
        join(stagedRoot, "package.json"),
        `${JSON.stringify(publicationManifest(entry.manifest, dependencySpecs), null, 2)}\n`,
      );
      const packOutput = JSON.parse(run("npm", ["pack", stagedRoot, "--json", "--ignore-scripts", "--pack-destination", publishRoot], smithersSourceRoot));
      const filename = packOutput[0]?.filename;
      if (typeof filename !== "string") throw new Error(`npm pack returned no filename for ${entry.manifest.name}`);
      packed.push({
        name: entry.manifest.name,
        version: entry.manifest.version,
        filename,
        sourceRoot: entry.sourceRoot,
      });
    }
    const sourceRevisions = {
      flows: run("git", ["rev-parse", "HEAD"], join(smithersSourceRoot, "flows")),
      agent: run("git", ["rev-parse", "HEAD"], join(smithersSourceRoot, "agent")),
      plugins: run("git", ["rev-parse", "HEAD"], join(smithersSourceRoot, "plugins")),
    };
    const manifest = { schemaVersion: 1, smithersSourceRoot, sourceRevisions, packages: packed };
    writeFileSync(join(publishRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const entry of [...packed.map((entry) => entry.filename), "manifest.json"]) {
      renameSync(join(publishRoot, entry), join(outputDirectory, entry));
    }
    return manifest;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(publishRoot, { recursive: true, force: true });
  }
};

export const smokeDistribution = (manifest, distributionRoot) => {
  const smokeRoot = mkdtempSync(join(tmpdir(), "mvp-smithers-consumer-"));
  try {
    const entryPackages = new Set(["@smithers/journal", "@smithers/harness", "@smithers/adapters", "@smithers/connectors"]);
    const dependencies = Object.fromEntries(manifest.packages.filter((entry) => entryPackages.has(entry.name)).map((entry) => [
      entry.name,
      `file:${join(resolve(distributionRoot), entry.filename)}`,
    ]));
    writeFileSync(join(smokeRoot, "package.json"), `${JSON.stringify({ private: true, type: "module", dependencies }, null, 2)}\n`);
    run("npm", ["install", "--ignore-scripts", "--package-lock=false"], smokeRoot);
    run("bun", ["--eval", [
      "await import('@smithers/journal')",
      "await import('@smithers/harness')",
      "await import('@smithers/adapters')",
      "await import('@smithers/connectors')",
    ].join("; ")], smokeRoot);
    return { consumer: "temporary", imported: [...entryPackages] };
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
};

export const main = (args) => {
  const destination = args[0];
  if (destination === undefined) throw new Error("usage: node build-local-smithers-distribution.mjs <output-directory> [--smoke]");
  const manifest = buildDistribution(destination);
  const smoke = args.includes("--smoke") ? smokeDistribution(manifest, destination) : null;
  process.stdout.write(`${JSON.stringify({ manifest, smoke }, null, 2)}\n`);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2));
}
