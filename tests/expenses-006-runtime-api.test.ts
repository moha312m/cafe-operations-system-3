import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db, fixture, pay, receive, body, http, snapshot, journal, login, type Expense } from "./helpers/expenses-runtime";
import { recomputeShiftTotals } from "@/lib/shifts";
after(async () => { await db.$disconnect(); });

test("real cash sources recompute to 1330, a documented return to 1350, and supplier payouts count once", { timeout: 180000 }, async () => {
  const fx = await fixture("CASH");
  const order = await db.order.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, orderNumber: 1, source: "CASHIER_POS", type: "TAKEAWAY", status: "SERVED", servedAt: new Date(), subtotal: 500, total: 500, paidAmount: 500, remainingAmount: 0, paymentStatus: "PAID", createdById: fx.manager.id } });
  const collection = await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: fx.shiftId, orderId: order.id, cashierId: fx.manager.id, receivedById: fx.manager.id, amount: 500, method: "CASH", type: "COLLECTION", status: "PAID", paidAt: new Date() } });
  await db.payment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, shiftId: fx.shiftId, orderId: order.id, cashierId: fx.manager.id, receivedById: fx.manager.id, amount: 50, method: "CASH", type: "REFUND", status: "PAID", reversalOfPaymentId: collection.id, paidAt: new Date() } });
  const paid = await pay(fx); assert.equal(paid.status, 201, JSON.stringify(paid.body));
  for (let i = 0; i < 2; i++) { await recomputeShiftTotals(fx.shiftId); const shift = await snapshot(fx); assert.equal(String(shift.expectedCashAmount), "1330"); assert.equal(String(shift.totalSales), "450"); assert.equal(String(shift.totalRefunds), "50"); assert.equal(String(shift.totalExpensePayouts), "120"); }
  const returned = await receive(fx, paid.body.id, 20); assert.equal(returned.status,201); assert.equal(String((await snapshot(fx)).expectedCashAmount), "1350");
  const supplier = await db.supplier.create({ data: { cafeId: fx.cafeId, name: fx.marker + " supplier" } });
  const invoice = await db.purchaseInvoice.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, supplierId: supplier.id, invoiceNumber: fx.marker, totalAmount: 30, paidAmount: 30, remainingAmount: 0, paymentStatus: "PAID" } });
  await db.purchasePayment.create({ data: { cafeId: fx.cafeId, branchId: fx.branchId, purchaseInvoiceId: invoice.id, amount: 30, method: "CASH", fundingSource: "DRAWER", shiftId: fx.shiftId, createdByUserId: fx.manager.id } });
  await recomputeShiftTotals(fx.shiftId); await recomputeShiftTotals(fx.shiftId);
  const shift = await snapshot(fx); assert.equal(String(shift.expectedCashAmount), "1320"); assert.equal(String(shift.totalCashPayouts), "30"); assert.equal(String(shift.totalSales), "450");
  journal("cash-arithmetic", { cafeId: fx.cafeId, expenseId: paid.body.id, returnIds: returned.body.returns.map(r=>r.id), expectedAfterPayout:1330, expectedAfterReturn:1350, expectedAfterSupplier:1320 });
});

test("cached payout and return replay survive full return and later close; changed payload and revoked permission are refused", { timeout: 120000 }, async () => {
  const fx = await fixture("REPLAY"); const key = randomUUID(), returnKey = randomUUID();
  const first = await pay(fx,100,key); assert.equal(first.status,201);
  const replay = await pay(fx,100,key); assert.equal(replay.status,201); assert.equal(replay.body.id,first.body.id); assert.equal(replay.headers.get("Idempotency-Replayed"),"true");
  assert.equal((await pay(fx,101,key)).status,409);
  const full = await receive(fx,first.body.id,100,returnKey); assert.equal(full.status,201); assert.equal(full.body.unrecoveredAmount,0);
  assert.equal((await receive(fx,first.body.id,100,returnKey)).status,201);
  const closed = await http(fx.manager,"/api/shifts/"+fx.shiftId+"/close","POST",{actualCashAmount:1000}); assert.equal(closed.status,200,JSON.stringify(closed.body));
  assert.equal((await pay(fx,100,key)).body.id,first.body.id); assert.equal((await receive(fx,first.body.id,100,returnKey)).status,201);
  const before = await snapshot(fx); assert.equal((await receive(fx,first.body.id,1)).status,400); assert.equal(String((await snapshot(fx)).expectedCashAmount),String(before.expectedCashAmount));
  const denied = await http(fx.owner,"/api/users/"+fx.manager.id+"/permissions","PUT",{overrides:[{key:"expenses.manage",allowed:false}]}); assert.equal(denied.status,200);
  const revoked = await pay(fx,100,key); assert.equal(revoked.status,403); assert.equal("id" in revoked.body,false);
  assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),1); assert.equal(await db.operatingExpenseReturn.count({where:{cafeId:fx.cafeId}}),1);
  assert.equal(await db.auditLog.count({where:{cafeId:fx.cafeId,action:"OPERATING_EXPENSE_PAID"}}),1); assert.equal(await db.auditLog.count({where:{cafeId:fx.cafeId,action:"OPERATING_EXPENSE_CASH_RETURNED"}}),1);
});

test("category ownership, branch metadata, expense-only permissions and tenant/branch isolation are enforced through HTTP", { timeout: 120000 }, async () => {
  const fx=await fixture("SCOPE"), foreign=await fixture("FOREIGN");
  const categoryBody={code:"OTHER",nameAr:"بند تشغيلي",classification:"OPERATING_EXPENSE"};
  assert.equal((await http(fx.manager,"/api/expenses/categories","POST",categoryBody)).status,403);
  const custom=await db.cafeRole.create({data:{cafeId:fx.cafeId,code:"EXPENSE_ONLY",name:"expense only",permissions:{create:["expenses.view","expenses.manage"].map(permissionKey=>({permissionKey,allowed:true}))}}});
  await db.user.update({where:{id:fx.manager.id},data:{cafeRoleId:custom.id}});
  const metadata=await http<{branches:{id:string}[]}>(fx.manager,"/api/expenses/categories"); assert.equal(metadata.status,200); assert.deepEqual(metadata.body.branches.map(b=>b.id),[fx.branchId]);
  const paid=await pay(fx,25); assert.equal(paid.status,201);
  assert.equal((await http(fx.manager,"/api/accounting/overview")).status,403);
  assert.equal((await http(fx.manager,"/api/expenses?branchId="+fx.otherBranchId)).status,403);
  assert.equal((await http(fx.manager,"/api/expenses","POST",{...body(fx,1),branchId:fx.otherBranchId},randomUUID())).status,404);
  const otherPaid=await pay(foreign,10); assert.equal(otherPaid.status,201);
  assert.equal((await http(fx.manager,"/api/expenses/"+otherPaid.body.id)).status,404);
  const listing=await http<{expenses:Expense[];totals:{paid:number}}>(fx.manager,"/api/expenses"); assert.equal(listing.status,200); assert.deepEqual(listing.body.expenses.map(e=>e.id),[paid.body.id]); assert.equal(listing.body.totals.paid,25);
  await db.userPermissionOverride.createMany({data:["expenses.manage","expenses.view"].map(permissionKey=>({userId:fx.cashier.id,permissionKey,allowed:true}))});
  assert.equal((await http(fx.cashier,"/api/expenses","POST",body(fx,1),randomUUID())).status,403);
  assert.equal((await http(fx.owner,"/api/expenses","POST",body(fx,1),randomUUID())).status,400,"owner authority does not grant another custodian's drawer");
  journal("scope-and-expense-only",{cafeId:fx.cafeId,expenseId:paid.body.id,roleId:custom.id});
});

test("invalid precision/capacity/alternate-flow inputs and archived categories cannot create cash sources", { timeout:120000 }, async()=>{
 const fx=await fixture("INPUT");
 for(const amount of [0,-1,1.001,10000000000,"12",null]){const r=await http(fx.manager,"/api/expenses","POST",{...body(fx),amount},randomUUID());assert.equal(r.status,400,JSON.stringify({amount,result:r.body}));}
 for(const extra of [{fundingSource:"BANK"},{purchaseInvoiceId:"p"},{classification:"WAGES"},{actorId:fx.owner.id}])assert.equal((await http(fx.manager,"/api/expenses","POST",{...body(fx),...extra},randomUUID())).status,400);
 assert.equal((await http(fx.owner,"/api/expenses/categories/"+fx.categoryId,"PATCH",{archived:true})).status,200);
 assert.equal((await pay(fx,1)).status,400);assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),0);assert.equal(String((await snapshot(fx)).expectedCashAmount),"1000");
});

test("blind expense-only access does not serialize expected cash or expose financial reports",{timeout:120000},async()=>{
 const fx=await fixture("BLIND");const role=await db.cafeRole.create({data:{cafeId:fx.cafeId,code:"BLIND",name:"synthetic blind",permissions:{create:["expenses.view","expenses.manage","shifts.view_current"].map(permissionKey=>({permissionKey,allowed:true}))}}});await db.userPermissionOverride.deleteMany({where:{userId:fx.manager.id}});await db.user.update({where:{id:fx.manager.id},data:{cafeRoleId:role.id}});
 const paid=await pay(fx,25);assert.equal(paid.status,201);const detail=await http(fx.manager,"/api/expenses/"+paid.body.id),list=await http(fx.manager,"/api/expenses"),active=await http(fx.manager,"/api/shifts/active?branchId="+fx.branchId);assert.equal(detail.status,200);assert.equal(list.status,200);assert.equal(active.status,200);
 for(const response of [paid,detail,list,active])for(const key of ["expectedCashAmount","cashDifference","totalCashSales","totalExpensePayouts","totalExpenseReturns"])assert.equal(JSON.stringify(response.body).includes('"'+key+'"'),false,key);
 assert.equal((await http(fx.manager,"/api/shifts/"+fx.shiftId+"/report")).status,403);assert.equal((await http(fx.manager,"/api/shifts/"+fx.shiftId)).status,403);
 const insufficient=await pay(fx,1000);assert.equal(insufficient.status,400);assert.equal(JSON.stringify(insufficient.body).includes("975"),false);
 // Inactive custom roles intentionally fall back to legacy; owned explicit grants continue to apply.
 await db.cafeRole.update({where:{id:role.id},data:{isActive:false}});await db.userPermissionOverride.createMany({data:["expenses.view","expenses.manage"].map(permissionKey=>({userId:fx.manager.id,permissionKey,allowed:true}))});assert.equal((await pay(fx,1)).status,201);
 // An accountant cannot gain drawer expense authority merely through key overrides.
 const accountant=await db.cafeRole.findUniqueOrThrow({where:{cafeId_code:{cafeId:fx.cafeId,code:"ACCOUNTANT"}}});await db.user.update({where:{id:fx.cashier.id},data:{cafeRoleId:accountant.id}});await db.userPermissionOverride.createMany({data:["expenses.view","expenses.manage"].map(permissionKey=>({userId:fx.cashier.id,permissionKey,allowed:true}))});assert.equal((await http(fx.cashier,"/api/expenses","POST",body(fx,1),randomUUID())).status,403);
 journal("blind-and-current-authority",{cafeId:fx.cafeId,expenseId:paid.body.id,reportsDenied:true,expectedCashFieldsAbsent:true});
});
test("non-cash channels and BANK supplier funding do not change cash; cash result capacity is enforced",{timeout:120000},async()=>{
 const fx=await fixture("CHANNELS");const order=await db.order.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,orderNumber:1,source:"CASHIER_POS",type:"TAKEAWAY",status:"SERVED",total:20,subtotal:20,paidAmount:20,paymentStatus:"PAID",createdById:fx.manager.id}});
 for(const method of ["CARD","WALLET"] as const)await db.payment.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,shiftId:fx.shiftId,orderId:order.id,cashierId:fx.manager.id,receivedById:fx.manager.id,amount:10,method,type:"COLLECTION",status:"PAID",paidAt:new Date()}});
 const supplier=await db.supplier.create({data:{cafeId:fx.cafeId,name:fx.marker}});const invoice=await db.purchaseInvoice.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,supplierId:supplier.id,invoiceNumber:fx.marker,totalAmount:30,paidAmount:30,paymentStatus:"PAID"}});await db.purchasePayment.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,purchaseInvoiceId:invoice.id,amount:30,method:"BANK_TRANSFER",fundingSource:"BANK",createdByUserId:fx.manager.id}});
 await recomputeShiftTotals(fx.shiftId);assert.equal(String((await snapshot(fx)).expectedCashAmount),"1000");
 await db.shift.update({where:{id:fx.shiftId},data:{openingCashAmount:"99999999.99"}});await db.payment.create({data:{cafeId:fx.cafeId,branchId:fx.branchId,shiftId:fx.shiftId,orderId:order.id,cashierId:fx.manager.id,receivedById:fx.manager.id,amount:1,method:"CASH",type:"COLLECTION",status:"PAID",paidAt:new Date()}});
 const refused=await pay(fx,0.01);assert.equal(refused.status,400,JSON.stringify(refused.body));assert.equal(await db.operatingExpense.count({where:{cafeId:fx.cafeId}}),0);journal("channels-and-result-capacity",{cafeId:fx.cafeId,expectedBeforeOverflow:1000,overflowResponse:refused.status});
});

test("owner with own current open drawer can pay and return, without acquiring another custodian's drawer",{timeout:120000},async()=>{
 const fx=await fixture("OWNER_CUSTODY");assert.equal((await http(fx.manager,"/api/shifts/"+fx.shiftId+"/close","POST",{actualCashAmount:1000})).status,200);
 const opened=await http<{shift:{id:string}}>(fx.owner,"/api/shifts","POST",{branchId:fx.branchId,openingCashAmount:1000});assert.equal(opened.status,201,JSON.stringify(opened.body));
 const paid=await http<Expense>(fx.owner,"/api/expenses","POST",body(fx,25),randomUUID());assert.equal(paid.status,201);assert.equal(paid.body.shiftId,opened.body.shift.id);assert.equal((await pay(fx,1)).status,400);
 const returned=await http<Expense>(fx.owner,"/api/expenses/"+paid.body.id+"/returns","POST",{amount:5,reason:"synthetic owner actual cash received"},randomUUID());assert.equal(returned.status,201);assert.equal(returned.body.returnedAmount,5);assert.equal(String((await db.shift.findUniqueOrThrow({where:{id:opened.body.shift.id}})).expectedCashAmount),"980");journal("owner-own-custody",{cafeId:fx.cafeId,shiftId:opened.body.shift.id,expenseId:paid.body.id});
});
