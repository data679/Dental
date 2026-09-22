import { Router } from "express";
import { z } from "zod";
import { getFinanceSummary } from "../services/financeService.js";

export const financeRouter = Router();

const filtersSchema = z.object({
  locationId: z.coerce.number().optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  applicationType: z.enum(["primary", "subprime", "unknown"]).optional(), // unknown = lender runs both, export didn't say
  status: z.enum(["submitted", "pending", "approved", "declined"]).optional(),
  statusDetail: z
    .enum(["submitted", "incomplete", "withdrawn", "cancelled", "expired", "in_review", "referred",
           "prequalified", "approved", "conditionally_approved", "pre_declined", "declined"])
    .optional(),
  outcomeClass: z.enum(["open", "decided", "abandoned"]).optional(),
  newPatientsOnly: z.coerce.boolean().optional(),
});

// GET /api/finance/summary — powers the Finance Report page (stat cards + the two
// by-lender charts). See docs/data-model.md: the two by-lender charts return [] until
// financing_applications has real rows.
financeRouter.get("/summary", async (req, res, next) => {
  try {
    const filters = filtersSchema.parse(req.query);
    const summary = await getFinanceSummary(filters);
    res.json(summary);
  } catch (err) {
    next(err);
  }
});
