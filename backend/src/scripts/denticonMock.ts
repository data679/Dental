import { createDenticonMockApp } from "../integrations/denticon/mock/server.js";

// `npm run denticon:mock` — local stand-in for the Denticon API. Then in .env:
//   DENTICON_API_BASE_URL=http://localhost:4900/denticon
//   DENTICON_SUBSCRIPTION_KEY=mock-key
// and run `npm run denticon:check` / `npm run worker` + `npm run denticon:sync -- --full`.

const port = Number(process.env.DENTICON_MOCK_PORT ?? 4900);
const key = process.env.DENTICON_MOCK_KEY ?? "mock-key";
const rateLimitEvery = Number(process.env.DENTICON_MOCK_RATE_LIMIT_EVERY ?? 0);
const seed = process.env.DENTICON_MOCK_SEED ? Number(process.env.DENTICON_MOCK_SEED) : undefined;

const { app, data } = createDenticonMockApp({ subscriptionKey: key, rateLimitEvery, seed });

app.listen(port, () => {
  console.log(`[denticon-mock] http://localhost:${port}/denticon  (PDDS-Subscription-Key: ${key})`);
  console.log(
    `[denticon-mock] ${data.offices.length} offices, ${data.providers.length} providers, ${data.patients.length} patients, ` +
      `${new Set(data.treatmentPlanItems.map((i) => i.treatPlanId)).size} treatment plans (${data.treatmentPlanItems.length} items), ` +
      `${data.appointments.length} appointments`,
  );
  if (rateLimitEvery) console.log(`[denticon-mock] returning 429 every ${rateLimitEvery} requests`);
});
