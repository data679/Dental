import { getDenticonClient, isDenticonConfigured, DenticonApiError } from "../integrations/denticon/index.js";

// `npm run denticon:check` — smoke-tests the credentials in .env without touching the
// database: fetches the practice group, lists offices/providers, and pulls one page of
// patients changed in the last 7 days. Prints counts only, never patient data.

async function main() {
  if (!isDenticonConfigured()) {
    console.error("DENTICON_SUBSCRIPTION_KEY is not set — copy .env.example to .env and fill it in.");
    process.exit(2);
  }
  const client = getDenticonClient();

  const practice = await client.getPractice();
  console.log(`practice group: ${practice.practiceGroupName} (pgId ${practice.pgId})`);

  const offices: number[] = [];
  for await (const o of client.listOffices()) {
    offices.push(Number(o.officeId));
    console.log(`  office ${o.officeId}: ${o.officeName}${o.officeActive === false ? " (inactive)" : ""}`);
  }

  let providers = 0;
  for await (const _ of client.listProviders()) providers += 1;
  console.log(`providers: ${providers}`);

  if (offices.length) {
    const to = new Date();
    const from = new Date(to.getTime() - 7 * 86_400_000);
    let patients = 0;
    for await (const _ of client.listPatients({
      OfficeId: offices[0],
      LastChangedOn: { DateFrom: from.toISOString(), DateTo: to.toISOString() },
      PageSize: 50,
    })) {
      patients += 1;
      if (patients >= 50) break;
    }
    console.log(`patients changed in last 7 days at office ${offices[0]}: ${patients}${patients >= 50 ? "+" : ""}`);
  }
  console.log("ok");
}

main().catch((err) => {
  if (err instanceof DenticonApiError) {
    console.error(`Denticon error (HTTP ${err.status}): ${err.message}`);
    if (err.status === 401 || err.status === 403) {
      console.error("→ check DENTICON_SUBSCRIPTION_KEY and that the key's product includes the Practices/Patients APIs");
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
