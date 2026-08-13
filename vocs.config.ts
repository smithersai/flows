import { defineConfig } from "vocs/config"

export default defineConfig({
  title: "Smithers Flows",
  description:
    "Smithers Flows is an Effect-based durable-execution engine: typed flows that replay from a journal, content-addressed activity results, capability-checked host access, read-only sync, and time travel over run history.",
  srcDir: "docs",
  outDir: "docs/dist",
  sidebar: [
    { text: "Introduction", link: "/" },
    { text: "Architecture", link: "/architecture" },
    { text: "Data structures", link: "/data-structures" },
    { text: "Package structure", link: "/package-structure" },
    {
      text: "Public API",
      items: [
        { text: "@smthrs/flows-next", link: "/api/flows" },
        { text: "@smthrs/jj-next", link: "/api/jj" },
        { text: "@smthrs/sandbox-next", link: "/api/sandbox" },
        { text: "@smthrs/platform-browser-next", link: "/api/platform-browser" },
        { text: "@smthrs/platform-node-next", link: "/api/platform-node" },
        { text: "@smthrs/platform-bun-next", link: "/api/platform-bun" },
        { text: "@smthrs/journal-next", link: "/api/journal" },
        { text: "@smthrs/run-store-next", link: "/api/run-store" },
        { text: "@smthrs/step-cache-next", link: "/api/step-cache" },
        { text: "@smthrs/artifacts-next", link: "/api/artifacts" },
        { text: "@smthrs/database-next", link: "/api/database" },
        { text: "@smthrs/capability-next", link: "/api/capability" },
        { text: "@smthrs/kernel-next", link: "/api/kernel" },
        { text: "@smthrs/canonical-next", link: "/api/canonical" },
        { text: "@smthrs/crypto-next", link: "/api/crypto" },
        { text: "@smthrs/keys-next", link: "/api/keys" },
        { text: "@smthrs/flow-next", link: "/api/flow" },
        { text: "@smthrs/engine-next", link: "/api/engine" },
        { text: "@smthrs/engine-store-next", link: "/api/engine-store" },
        { text: "@smthrs/sync-next", link: "/api/sync" },
        { text: "@smthrs/time-travel-next", link: "/api/time-travel" }
      ]
    },
    { text: "Internal details", link: "/internals" },
    { text: "Public API tests", link: "/api-tests" },
    { text: "Observability", link: "/observability" },
    { text: "Examples", link: "/examples" },
    { text: "Design decisions", link: "/design-decisions" },
    { text: "External", link: "/external" },
    { text: "Contributor plan", link: "/contributing" }
  ],
  topNav: [
    { text: "GitHub", link: "https://github.com/smithersai/flows" }
  ],
  socials: [
    { icon: "github", link: "https://github.com/smithersai/flows" }
  ]
})
