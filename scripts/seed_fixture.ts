import { seedFixtureLedger } from "../tests/fixtures/ledger/seed.ts";

await seedFixtureLedger(process.cwd());
process.stdout.write("seeded sag_fixture\n");
