import { createFileRoute } from "@tanstack/react-router";

/** The app keeps its own navigation; this route only gives the root shell an exact URL match. */
export const Route = createFileRoute("/")({ component: () => null });
