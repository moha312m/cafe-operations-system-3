import fs from 'node:fs';
import path from 'node:path';
const configFile = path.resolve('artifacts/workspace-redesign-20261102/private-step1-config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
process.env.NEXTCUP_WORKSPACE_CONFIG = configFile;
process.env.NEXTCUP_WORKSPACE_FIXTURES = path.resolve('artifacts/workspace-redesign-20261102/private-fixtures.json');
process.env.DATABASE_URL = config.databaseUrl;
const { verifyWorkspace } = await import('../workspace-redesign-20261102/workspace-guard.mjs');
try {
  const { proof } = await verifyWorkspace({ requireCorrespondence: true });
  const result = { state: 'VERIFIED', ...proof, url: config.baseUrl };
  fs.writeFileSync('artifacts/erp-experience-20261102/correspondence.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (e) {
  const result = { state: 'UNVERIFIED', at: new Date().toISOString(), error: e.message, noMutationsAttempted: true };
  fs.writeFileSync('artifacts/erp-experience-20261102/runtime-gap.json', JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result)); process.exitCode = 1;
}
