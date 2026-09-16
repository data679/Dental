import { Router } from "express";
import { pool } from "../db/pool.js";

export const locationsRouter = Router();

// GET /api/locations — powers the "Practice Name" filter dropdown.
locationsRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query<{ id: number; name: string }>(
      "SELECT id, name FROM locations ORDER BY name",
    );
    res.json({ locations: rows });
  } catch (err) {
    next(err);
  }
});
