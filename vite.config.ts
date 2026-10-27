import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "/" because routes are real paths (/databases/…): relative asset URLs would break on them.
export default defineConfig({ base: "/", plugins: [react()] });
