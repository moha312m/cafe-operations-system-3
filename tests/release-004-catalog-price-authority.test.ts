// Catalog-price edits must not bypass an explicit price-authority denial.
import {before,after,test} from "node:test";
import assert from "node:assert/strict";
import {db,teardownTaggedCafe} from "./helpers/db";
import {countCafe,type CountCafe} from "./helpers/count";
import {as,requireServer} from "./helpers/http";
import {validateRow} from "@/lib/menu-import";
let fx:CountCafe;let productId:string;let categoryId:string;
before(async()=>{
  await requireServer();fx=await countCafe("REL004");
  categoryId=(await db.menuCategory.create({data:{cafeId:fx.cafeId,name:"Price scope"}})).id;
  productId=(await db.product.create({data:{cafeId:fx.cafeId,categoryId,name:"Original price",basePrice:90}})).id;
  await db.userPermissionOverride.create({data:{userId:fx.manager.id,permissionKey:"menu.edit_prices",allowed:false}});
});
after(()=>teardownTaggedCafe(fx?[fx.cafeId]:[],[],{disconnect:true}));
test("explicit price denial prevents base variant and branch override edits without mutation",async()=>{
  for(const body of [{basePrice:1},{variants:[{name:"Cheap",price:1}]},{branchPrices:[{branchId:fx.branchId,price:1}]}]) {
    const before=await db.product.findUniqueOrThrow({where:{id:productId},include:{variants:true,branchPrices:true}});
    const r=await as(fx.manager.email,`/api/products/${productId}`,{method:"PATCH",body:JSON.stringify(body)});
    assert.equal(r.status,403,r.text);
    assert.deepEqual(await db.product.findUniqueOrThrow({where:{id:productId},include:{variants:true,branchPrices:true}}),before);
  }
});
test("product addon and import price-entry paths all honor denial",async()=>{
  for(const [path,body] of [
    ["/api/products",{name:"Cheap product",categoryId,basePrice:1}],
    ["/api/addons",{name:"Cheap addon",price:1}],
    ["/api/menu-import",{mode:"upsert",rows:[{ProductName:"Cheap import",Category:"Price scope",BasePrice:1}]}],
  ] as const) {
    const products=await db.product.count({where:{cafeId:fx.cafeId}}),addons=await db.addOn.count({where:{cafeId:fx.cafeId}});
    const r=await as(fx.manager.email,path,{method:"POST",body:JSON.stringify(body)});
    assert.equal(r.status,403,r.text);
    assert.equal(await db.product.count({where:{cafeId:fx.cafeId}}),products);
    assert.equal(await db.addOn.count({where:{cafeId:fx.cafeId}}),addons);
  }
});
test("nonprice edits retain authority and a granted actor can change price",async()=>{
  assert.equal((await as(fx.manager.email,`/api/products/${productId}`,{method:"PATCH",body:JSON.stringify({name:"Renamed"})})).status,200);
  assert.equal((await as(fx.owner.email,`/api/products/${productId}`,{method:"PATCH",body:JSON.stringify({basePrice:89.99})})).status,200);
  assert.equal((await db.product.findUniqueOrThrow({where:{id:productId}})).basePrice.toString(),"89.99");
});
test("invalid precision is refused instead of being silently rounded by storage",async()=>{
  for(const basePrice of [0.001,100000000]) {
    const r=await as(fx.owner.email,`/api/products/${productId}`,{method:"PATCH",body:JSON.stringify({basePrice})});
    assert.equal(r.status,400,r.text);
  }
});
test("import validation refuses out-of-range and fractional-cent catalog prices",()=>{
  for(const extra of [{price:0.001},{variantName:"Small",variantPrice:-1},{addonName:"Milk",addonPrice:Infinity},{price:100000000}]) {
    assert.ok(validateRow({category:"Drinks",productName:"Coffee",price:90,...extra},1).errors.length>0);
  }
  assert.equal(validateRow({category:"Drinks",productName:"Coffee",price:89.99,addonName:"Milk",addonPrice:0},1).errors.length,0);
});
