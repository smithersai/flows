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
        { text: "@smthrs/flows", link: "/api/flows" },
        { text: "@smthrs/keys", link: "/api/keys" },
        { text: "@smthrs/database", link: "/api/database" },
        { text: "@smthrs/host", link: "/api/host" },
        { text: "@smthrs/journal", link: "/api/journal" },
        { text: "@smthrs/kernel", link: "/api/kernel" },
        { text: "@smthrs/engine", link: "/api/engine" },
        { text: "@smthrs/engine-store", link: "/api/engine-store" },
        { text: "@smthrs/plugin", link: "/api/plugin" },
        { text: "@smthrs/sync", link: "/api/sync" },
        { text: "@smthrs/time-travel", link: "/api/time-travel" }
      ]
    },
    { text: "Internal details", link: "/internals" },
    { text: "Public API tests", link: "/api-tests" },
    { text: "Observability", link: "/observability" },
    { text: "Examples", link: "/examples" },
    { text: "Design decisions", link: "/design-decisions" },
    { text: "External", link: "/external" },
    { text: "Epics and commit plan", link: "/epics" }
  ],
  topNav: [
    { text: "GitHub", link: "https://github.com/smithersai/flows" }
  ],
  socials: [
    { icon: "github", link: "https://github.com/smithersai/flows" }
  ]
})
