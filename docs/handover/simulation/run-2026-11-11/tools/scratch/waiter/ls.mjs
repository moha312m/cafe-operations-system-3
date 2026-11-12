import fs from 'fs';
const t=fs.readFileSync(process.argv[2],'utf8');const s=t.indexOf('{"orders"');
const j=JSON.parse(t.slice(s).replace(/[\u0000-\u001f]/g,' ').replace(/…\(\+\d+ chars\)\s*$/,''));
