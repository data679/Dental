import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { funnelRouter } from "./routes/funnel.js";
import { financeRouter } from "./routes/finance.js";
import { locationsRouter } from "./routes/locations.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/funnel", funnelRouter);
app.use("/api/finance", financeRouter);
app.use("/api/locations", locationsRouter);

// Centralized error handler — never leak stack traces/internals to the client.
app.use((err: unknown, _req: express.Request, res: express.Response) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT}`);
});
