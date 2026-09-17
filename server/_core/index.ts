import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerStorageProxy } from "./storageProxy";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { resumeWhatsAppSessions } from "../whatsapp";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => server.close(() => resolve(true)));
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);
  const allowedOrigins = new Set(
    (process.env.PUBLIC_APP_ORIGINS ?? "https://whappnus.online,https://www.whappnus.online")
      .split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  );
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  app.use("/api", (req, res, next) => {
    const startedAt = Date.now();
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,TRPC-Accept");
      res.setHeader("Vary", "Origin");
    }
    res.on("finish", () => {
      console.info("[API]", JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
        origin,
      }));
    });
    if (req.method === "OPTIONS") {
      if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: "origin_not_allowed" });
      return res.sendStatus(204);
    }
    next();
  });
  registerStorageProxy(app);
  registerOAuthRoutes(app);

  app.use("/api/trpc", createExpressMiddleware({ router: appRouter, createContext }));
  if (process.env.NODE_ENV === "development") await setupVite(app, server);
  else serveStatic(app);
  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    void resumeWhatsAppSessions();
  });
}

startServer().catch(console.error);
