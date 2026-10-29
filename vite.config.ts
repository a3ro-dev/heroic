import { defineConfig, type Plugin } from "vite";

// Dev only: the app POSTs its timings here in ?src= test mode so they can be read from the terminal.
const devStats: Plugin = {
  name: "heroic-dev-stats",
  apply: "serve",
  configureServer(server) {
    server.middlewares.use("/__stats", (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        console.log("[stats]", body);
        res.end();
      });
    });
  },
};

export default defineConfig({
  clearScreen: false,
  plugins: [devStats],
  server: { port: 5173, strictPort: true, host: process.env.TAURI_DEV_HOST || false },
  build: { target: "es2022", chunkSizeWarningLimit: 2000 },
});
