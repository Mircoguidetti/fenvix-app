import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "/" because routes are real paths (/projects/…, /projects/connect?github=…): relative asset URLs would break on them.
export default defineConfig({ base: "/", plugins: [react()] });
