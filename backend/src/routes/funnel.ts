import { Router } from "express";
import { z } from "zod";
import { getFunnelSummary } from "../services/funnelService.js";

export const funnelRouter = Router();

const filtersSchema = z.object({
  locationId: z.coerce.number().optional(),
  providerId: z.coerce.number().optional(),
  lender: z
    .enum(["hfd", "alphaeon", "cherry", "care_credit", "proceed", "covered_care", "eve", "sunbit", "fortiva", "access"])
    .optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

// GET /api/funnel/summary?locationId=&providerId=&lender=&dateFrom=&dateTo=
funnelRouter.get("/summary", async (req, res, next) => {
  try {
    const filters = filtersSchema.parse(req.query);
    const summary = await getFunnelSummary(filters);
    res.json({ filters, ...summary });
  } catch (err) {
    next(err);
  }
});
