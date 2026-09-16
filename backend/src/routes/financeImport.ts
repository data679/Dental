import { Router, text } from "express";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { CANONICAL_COLUMNS } from "../etl/financing/columns.js";
import { toCsvLine } from "../etl/financing/csv.js";
import { ImportValidationError, importFinancingCsv, rematchUnmatchedApplications } from "../etl/financing/importService.js";

// Financing CSV intake endpoints, mounted under /api/finance. Unauthenticated until Auth0
// lands (same as everything else) — gate these first, they write data.
export const financeImportRouter = Router();

// GET /api/finance/import/template — a CSV with the canonical headers + one example row.
financeImportRouter.get("/import/template", (_req, res) => {
  const example: Record<(typeof CANONICAL_COLUMNS)[number], string> = {
    external_id: "APP-12345",
    lender: "CareCredit",
    application_type: "prime",
    status: "Approved",
    submitted_date: "2026-09-01",
    decision_date: "2026-09-01",
    requested_amount: "2500",
    approved_amount: "3000",
    decline_reason: "",
    funded_date: "2026-09-10",
    funded_amount: "2450",
    location: "West Covina",
    patient_id: "",
    chart_no: "",
    patient_first_name: "Jane",
    patient_last_name: "Doe",
    patient_dob: "1985-04-12",
  };
  const body = [toCsvLine([...CANONICAL_COLUMNS]), toCsvLine(CANONICAL_COLUMNS.map((c) => example[c]))].join("\n") + "\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="financing-import-template.csv"');
  res.send(body);
});

const jsonBody = z.object({
  csv: z.string().min(1),
  sourceFile: z.string().min(1).max(255).default("upload.csv"),
  importedBy: z.string().max(255).optional(),
});

// POST /api/finance/import — body is either raw text/csv (with ?sourceFile=) or JSON
// { csv, sourceFile, importedBy }. Parses, validates, lands in staging and upserts
// applications/fundings in one transaction; responds with per-row outcomes.
financeImportRouter.post("/import", text({ type: ["text/csv", "text/plain"], limit: "20mb" }), async (req, res, next) => {
  try {
    let input;
    if (typeof req.body === "string") {
      input = {
        csvText: req.body,
        sourceFile: String(req.query.sourceFile ?? "upload.csv").slice(0, 255),
        importedBy: req.query.importedBy ? String(req.query.importedBy).slice(0, 255) : undefined,
      };
    } else {
      const b = jsonBody.parse(req.body);
      input = { csvText: b.csv, sourceFile: b.sourceFile, importedBy: b.importedBy };
    }
    const result = await importFinancingCsv(input);
    res.status(result.rejected === result.rowCount && result.rowCount > 0 ? 422 : 200).json(result);
  } catch (err) {
    if (err instanceof ImportValidationError) {
      res.status(400).json({ error: err.message, ...err.details });
      return;
    }
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request body", issues: err.issues });
      return;
    }
    next(err);
  }
});

// GET /api/finance/imports — recent batches for the import page's history table.
financeImportRouter.get("/imports", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, source_file, imported_by, imported_at, row_count, inserted, updated, unmatched, rejected, errors
         FROM financing_import_batches ORDER BY imported_at DESC LIMIT 50`,
    );
    res.json({ imports: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/finance/imports/:id/rows — per-row outcomes of one batch (for troubleshooting).
financeImportRouter.get("/imports/:id/rows", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT row_number, outcome, outcome_detail, raw
         FROM staging_financing_csv WHERE batch_id = $1 ORDER BY row_number`,
      [Number(req.params.id)],
    );
    res.json({ rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/finance/rematch — retry linking unmatched applications to patients.
financeImportRouter.post("/rematch", async (_req, res, next) => {
  try {
    res.json(await rematchUnmatchedApplications());
  } catch (err) {
    next(err);
  }
});

// GET /api/finance/unmatched — applications with no patient link, for manual review.
financeImportRouter.get("/unmatched", async (_req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT fa.id, fa.lender, fa.status, fa.submitted_date::text AS submitted_date, fa.external_id, fa.match_status, fa.match_detail,
              l.name AS location, s.normalized->>'patientFirstName' AS first_name,
              s.normalized->>'patientLastName' AS last_name, s.normalized->>'patientDob' AS dob
         FROM financing_applications fa
         LEFT JOIN locations l ON l.id = fa.location_id
         LEFT JOIN staging_financing_csv s ON s.id = fa.staging_row_id
        WHERE fa.match_status <> 'matched'
        ORDER BY fa.submitted_date DESC NULLS LAST LIMIT 500`,
    );
    res.json({ unmatched: rows });
  } catch (err) {
    next(err);
  }
});
