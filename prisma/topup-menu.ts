// Idempotent menu top-up: ensures every category, add-on, and product
// from DEMO_MENU exists for the given cafe (default: demo-roasters).
// Safe to run repeatedly; never touches existing rows.
//
//   npx tsx prisma/topup-menu.ts [cafe-slug]   (default: qahwet-el-madina)

import { PrismaClient } from "@prisma/client";
import { DEMO_ADD_ONS, DEMO_MENU } from "./menu-data";

const db = new PrismaClient();

async function main() {
  const slug = process.argv[2] ?? "qahwet-el-madina";
  const cafe = await db.cafe.findUnique({ where: { slug } });
  if (!cafe) throw new Error(`Cafe with slug "${slug}" not found`);

  // Add-ons by name
  const addOnIds = new Map<string, string>();
  for (const def of DEMO_ADD_ONS) {
    const existing = await db.addOn.findFirst({
      where: { cafeId: cafe.id, name: def.name },
    });
    const addOn =
      existing ??
      (await db.addOn.create({ data: { cafeId: cafe.id, ...def } }));
    addOnIds.set(def.name, addOn.id);
  }

  let created = 0;
  for (const [i, group] of DEMO_MENU.entries()) {
    const category =
      (await db.menuCategory.findFirst({
        where: { cafeId: cafe.id, name: group.category },
      })) ??
      (await db.menuCategory.create({
        data: { cafeId: cafe.id, name: group.category, sortOrder: i },
      }));

    for (const item of group.items) {
      const exists = await db.product.findFirst({
        where: { cafeId: cafe.id, name: item.name },
      });
      if (exists) continue;
      await db.product.create({
        data: {
          cafeId: cafe.id,
          categoryId: category.id,
          name: item.name,
          description: item.description,
          basePrice: item.basePrice,
          costPrice: item.costPrice ?? null,
          isAvailable: item.isAvailable ?? true,
          showInCustomerMenu: item.showInCustomerMenu ?? true,
          variants: {
            create: (item.variants ?? []).map((v, k) => ({
              name: v.name,
              price: v.price,
              sortOrder: k,
            })),
          },
          addOns: {
            create: (item.addOns ?? []).map((name) => ({
              addOnId: addOnIds.get(name)!,
            })),
          },
        },
      });
      created++;
      console.log(`+ ${group.category} / ${item.name}`);
    }
  }
  console.log(`Done. ${created} product(s) added to ${cafe.name}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
