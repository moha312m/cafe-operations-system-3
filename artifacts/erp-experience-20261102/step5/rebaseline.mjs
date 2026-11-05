// Step 5 preview evidence: a new source manifest and config. The guard copy, migrations (93, unchanged since 4B.2)
// and database pins are carried over from the 4B.2 config; the reviewed guard and every earlier config stay untouched.
import fs from 'node:fs';import path from 'node:path';
import { sourceFiles, sha } from '../../workspace-redesign-20261102/workspace-guard-4b2.mjs';
const dir = path.resolve('artifacts/workspace-redesign-20261102');
const config = JSON.parse(fs.readFileSync(path.join(dir, 'private-step4b2-config.json'), 'utf8'));
const files = Object.fromEntries(sourceFiles().map(p => [p, sha(fs.readFileSync(p))]));
const file = path.resolve('artifacts/erp-experience-20261102/step5/source.json');
fs.writeFileSync(file, JSON.stringify(files, null, 2));
config.source = { file, sha256: sha(fs.readFileSync(file)) };
fs.writeFileSync(path.join(dir, 'private-step5-config.json'), JSON.stringify(config, null, 2));
console.log(JSON.stringify({ sourceFiles: Object.keys(files).length, sourceSha256: config.source.sha256, migrations: config.migrations.count }));
