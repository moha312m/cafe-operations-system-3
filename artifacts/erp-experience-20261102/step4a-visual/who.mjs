import fs from 'node:fs';import {PrismaClient} from '@prisma/client';
const c=JSON.parse(fs.readFileSync('artifacts/workspace-redesign-20261102/private-step4a-config.json'));
const f=JSON.parse(fs.readFileSync('artifacts/workspace-redesign-20261102/private-fixtures.json'));
const db=new PrismaClient({datasourceUrl:c.databaseUrl});
const o=await db.user.findUnique({where:{id:f.ownerUserId||f.fixtures?.ownerUserId}});
console.log(o?.email,o?.role);
const m=await db.user.findMany({where:{cafeId:o.cafeId,role:'BRANCH_MANAGER'},select:{email:true,branchId:true}});console.log(m);
await db.$disconnect();
