// New manifest + config for the Step 4A visual revision. The reviewed guard and the original step4a config stay untouched.
import fs from 'node:fs';import path from 'node:path';
import { sourceFiles, sha } from '../../workspace-redesign-20261102/workspace-guard.mjs';
const base=path.resolve('artifacts/workspace-redesign-20261102/private-step4a-config.json');
const config=JSON.parse(fs.readFileSync(base,'utf8'));
const files=Object.fromEntries(sourceFiles().map(p=>[p,sha(fs.readFileSync(p))]));
const file=path.resolve('artifacts/erp-experience-20261102/step4a-visual/source.json');
fs.writeFileSync(file,JSON.stringify(files,null,2));
config.source={file,sha256:sha(fs.readFileSync(file))};
fs.writeFileSync(path.resolve('artifacts/workspace-redesign-20261102/private-step4a-visual-config.json'),JSON.stringify(config,null,2));
console.log(JSON.stringify({sourceFiles:Object.keys(files).length,sha256:config.source.sha256}));
