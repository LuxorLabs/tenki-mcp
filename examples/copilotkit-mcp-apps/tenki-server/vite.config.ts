import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// One self-contained HTML file (JS + CSS inlined): MCP App resources are served as a single document.
export default defineConfig({
	plugins: [react(), viteSingleFile()],
	build: {
		outDir: "dist",
		emptyOutDir: false,
		sourcemap: false,
		rollupOptions: { input: "index.html" },
	},
});
