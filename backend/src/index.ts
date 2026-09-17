import express from "express";
import cors from "cors";
import { env } from "./config/env.js";
import { funnelRouter } from "./routes/funnel.js";
import { financeRouter } from "./routes/finance.js";
import { financeImportRouter } from "./routes/financeImport.js";
import { locationsRouter } from "./routes/locations.js";
import { denticonRouter } from "./routes/denticon.js";
import { dataQualityRouter } from "./routes/dataQuality.js";
import { bcpRouter } from "./routes/bcp.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/funnel", funnelRouter);
app.use("/api/finance", financeImportRouter);
app.use("/api/finance", financeRouter);
app.use("/api/locations", locationsRouter);
app.use("/api/denticon", denticonRouter);
app.use("/api/data-quality", dataQualityRouter);
app.use("/api/bcp", bcpRouter);

// Centralized error handler — never leak stack traces/internals to the client.
// (Express only recognises an error handler by its arity: all four params are required.)
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(env.PORT, () => {
  console.log(`[api] listening on http://localhost:${env.PORT}`);
});
