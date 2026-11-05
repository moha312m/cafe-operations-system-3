import fs from'node:fs';import postcss from'postcss';import tailwind from'@tailwindcss/postcss';
const result=await postcss([tailwind()]).process(fs.readFileSync('src/app/globals.css','utf8'),{from:'src/app/globals.css'});
fs.writeFileSync('artifacts/erp-experience-20261102/step1b/theme-compiled.css',result.css);
const proof={at:new Date().toISOString(),bytes:Buffer.byteLength(result.css),warnings:result.warnings().map(w=>w.toString())};fs.writeFileSync('artifacts/erp-experience-20261102/step1b/css-result.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));
