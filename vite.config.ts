import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" keeps the static output relocatable (any path or CDN prefix).
export default defineConfig({ base: "./", plugins: [react()] });
