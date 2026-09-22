import { Router } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { retierLender } from "../services/lenderService.js";

// Lender configuration: labels and which programs (prime / subprime) each lender runs.
// Read by the dashboard for the lender dropdown and by the importer to resolve tiers.
// Unauthenticated until Auth0 lands — PUT must be admin-only then.
export const lendersRouter = Router();

lendersRouter.get("/", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT code, label, offers_prime, offers_subprime, active, notes,
              (SELECT count(*)::int FROM financing_applications fa WHERE fa.lender = l.code) AS applications,
              (SELECT count(*)::int FROM financing_applications fa WHERE fa.lender = l.code AND fa.application_type IS NULL) AS unknown_tier
         FROM lenders l ORDER BY sort_order, code`,
    );
    res.json({ lenders: rows });
  } catch (err) {
    next(err);
  }
});

const patch = z.object({
  label: z.string().min(1).max(60).optional(),
  offersPrime: z.boolean().optional(),
  offersSubprime: z.boolean().optional(),
  active: z.boolean().optional(),
  notes: z.string().max(500).nullable().optional(),
});

// `code` is a Postgres enum: an unknown string fails at bind time (22P02 → 500), so check
// it against the table first and answer 404 like a normal lookup miss.
async function knownCode(code: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM lenders WHERE code::text = $1", [code]);
  return rows.length > 0;
}

// PUT /api/lenders/:code — update tiers/labels. Does not rewrite existing applications;
// re-import the lender's file (or run POST /api/lenders/:code/retier) to apply.
lendersRouter.put("/:code", async (req, res, next) => {
  try {
    const b = patch.parse(req.body ?? {});
    if (!(await knownCode(req.params.code))) {
      res.status(404).json({ error: "unknown lender" });
      return;
    }
    const { rows } = await pool.query(
      `UPDATE lenders SET
         label = COALESCE($2, label),
         offers_prime = COALESCE($3, offers_prime),
         offers_subprime = COALESCE($4, offers_subprime),
         active = COALESCE($5, active),
         notes = CASE WHEN $6::boolean THEN $7 ELSE notes END,
         updated_at = now()
       WHERE code::text = $1 RETURNING *`,
      [req.params.code, b.label ?? null, b.offersPrime ?? null, b.offersSubprime ?? null, b.active ?? null, b.notes !== undefined, b.notes ?? null],
    );
    res.json({ lender: rows[0] });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid body", issues: err.issues });
      return;
    }
    // CHECK (offers_prime OR offers_subprime) — the merged state must keep at least one tier.
    if ((err as { code?: string }).code === "23514") {
      res.status(400).json({ error: "a lender must offer at least one tier (prime or subprime)" });
      return;
    }
    next(err);
  }
});

// POST /api/lenders/:code/retier — re-derive the tier of this lender's applications whose
// tier did NOT come from a file (lender_only_tier / unknown) from the current configuration.
lendersRouter.post("/:code/retier", async (req, res, next) => {
  try {
    if (!(await knownCode(req.params.code))) {
      res.status(404).json({ error: "unknown lender" });
      return;
    }
    const result = await retierLender(req.params.code);
    if (!result) {
      res.status(404).json({ error: "unknown lender" });
      return;
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});
