import { defineConfig } from "drizzle-kit";

// DATABASE_URL is only needed for commands that open a connection (migrate/push).
// `generate` just diffs the schema file against migration history, so don't
// require it here or the automatic `drizzle-kit generate` build step fails.
const connectionString = process.env.DATABASE_URL ?? "";

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "mysql",
  dbCredentials: {
    url: connectionString,
  },
});
