import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function getBasePath(): string {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return "/";
  }

  const repoName = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (!repoName) {
    return "/";
  }

  if (repoName.endsWith(".github.io")) {
    return "/";
  }

  return `/${repoName}/`;
}

export default defineConfig({
  base: getBasePath(),
  plugins: [react()],
  preview: {
    host: "0.0.0.0",
    allowedHosts: true,
  },
  server: {
    port: 1420,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
