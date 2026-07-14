import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { DEMO_ADD_ONS, DEMO_MENU } from "./menu-data";

const db = new PrismaClient();
const hash = (pw: string) => bcrypt.hash(pw, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;

async function main() {
  // Idempotent-ish: bail if already seeded.
  if (await db.user.findUnique({ where: { email: "admin@cafeops.dev" } })) {
    console.log("Already seeded, skipping.");
    return;
  }

  await db.user.create({
    data: {
      email: "admin@cafeops.dev",
      name: "أدمن المنصة",
      passwordHash: await hash("admin1234"),
      role: "SUPER_ADMIN",
    },
  });

  const cafe = await db.cafe.create({
    data: {
      name: "قهوة المدينة",
      slug: "qahwet-el-madina",
      currency: "EGP",
      taxRate: 14, // ضريبة القيمة المضافة في مصر
    },
  });

  const tagamo3 = await db.branch.create({
    data: {
      cafeId: cafe.id,
      name: "فرع التجمع",
      address: "التجمع الخامس، القاهرة الجديدة",
      phone: "0100-000-0101",
      menuSlug: "tagamoa",
    },
  });
  const nasrCity = await db.branch.create({
    data: {
      cafeId: cafe.id,
      name: "فرع مدينة نصر",
      address: "شارع عباس العقاد، مدينة نصر",
      phone: "0100-000-0102",
      menuSlug: "nasr-city",
    },
  });
  const zayed = await db.branch.create({
    data: {
      cafeId: cafe.id,
      name: "فرع الشيخ زايد",
      address: "الحي الأول، الشيخ زايد",
      phone: "0100-000-0103",
      menuSlug: "sheikh-zayed",
    },
  });

  const owner = await db.user.create({
    data: {
      cafeId: cafe.id,
      email: "owner@demo.com",
      name: "أحمد المالك",
      passwordHash: await hash("owner1234"),
      role: "CAFE_OWNER",
    },
  });
  // حساب صاحب الكافيه الرسمي للديمو (owner@qahwa.local)
  const demoOwner = await db.user.create({
    data: {
      cafeId: cafe.id,
      email: "owner@qahwa.local",
      name: "أحمد المالك",
      passwordHash: await hash("password123"),
      role: "CAFE_OWNER",
    },
  });
  await db.auditLog.create({
    data: {
      cafeId: cafe.id,
      userId: demoOwner.id,
      action: "OWNER_ACCOUNT_CREATED",
      entity: "User",
      entityId: demoOwner.id,
      details: { email: "owner@qahwa.local", name: "أحمد المالك" },
    },
  });
  await db.user.create({
    data: {
      cafeId: cafe.id,
      branchId: tagamo3.id,
      email: "manager@demo.com",
      name: "محمد المدير",
      passwordHash: await hash("manager123"),
      role: "BRANCH_MANAGER",
    },
  });
  const cashier = await db.user.create({
    data: {
      cafeId: cafe.id,
      branchId: tagamo3.id,
      email: "cashier@demo.com",
      name: "كريم الكاشير",
      passwordHash: await hash("cashier123"),
      role: "CASHIER",
    },
  });
  await db.user.create({
    data: {
      cafeId: cafe.id,
      branchId: tagamo3.id,
      email: "kitchen@demo.com",
      name: "يوسف الباريستا",
      passwordHash: await hash("kitchen123"),
      role: "BARISTA",
    },
  });
  const waiter = await db.user.create({
    data: {
      cafeId: cafe.id,
      branchId: tagamo3.id,
      email: "waiter@demo.com",
      name: "وليد الويتر",
      passwordHash: await hash("waiter123"),
      role: "WAITER",
    },
  });

  // Menu from the shared demo definition (prisma/menu-data.ts).
  const addOnIds = new Map<string, string>();
  for (const def of DEMO_ADD_ONS) {
    const addOn = await db.addOn.create({ data: { cafeId: cafe.id, ...def } });
    addOnIds.set(def.name, addOn.id);
  }

  const branchBySlug = new Map([
    ["tagamoa", tagamo3.id],
    ["nasr-city", nasrCity.id],
    ["sheikh-zayed", zayed.id],
  ]);

  const products = [];
  for (const [i, group] of DEMO_MENU.entries()) {
    const category = await db.menuCategory.create({
      data: { cafeId: cafe.id, name: group.category, sortOrder: i },
    });
    for (const [j, item] of group.items.entries()) {
      products.push(
        await db.product.create({
          data: {
            cafeId: cafe.id,
            categoryId: category.id,
            name: item.name,
            description: item.description,
            basePrice: item.basePrice,
            costPrice: item.costPrice ?? null,
            sortOrder: j,
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
            branchPrices: {
              create: Object.entries(item.branchPrices ?? {}).map(
                ([slug, price]) => ({
                  branchId: branchBySlug.get(slug)!,
                  price,
                })
              ),
            },
          },
          include: { variants: true },
        })
      );
    }
  }

  // Historical completed orders over the past week so the dashboard,
  // report, and top-products views have something to show.
  const methods = ["CASH", "CARD", "WALLET"] as const;
  const orderCounters = new Map<string, number>();

  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const ordersToday = 3 + ((daysAgo * 7) % 5); // 3..7, deterministic
    for (let n = 0; n < ordersToday; n++) {
      const branch = n % 3 === 0 ? nasrCity : n % 3 === 1 ? tagamo3 : zayed;
      const when = new Date();
      when.setDate(when.getDate() - daysAgo);
      when.setHours(9 + ((n * 3) % 9), (n * 17) % 60, 0, 0);

      const itemCount = 1 + (n % 3);
      let subtotal = 0;
      const items = [];
      for (let i = 0; i < itemCount; i++) {
        const product = products[(n + i * 2 + daysAgo) % products.length];
        const variant =
          product.variants.length > 0
            ? product.variants[(n + i) % product.variants.length]
            : null;
        const quantity = 1 + ((n + i) % 2);
        const unitPrice = round2(
          variant ? Number(variant.price) : Number(product.basePrice)
        );
        const lineTotal = round2(unitPrice * quantity);
        subtotal = round2(subtotal + lineTotal);
        items.push({
          productId: product.id,
          variantId: variant?.id ?? null,
          productName: product.name,
          variantName: variant?.name ?? null,
          unitPrice,
          quantity,
          lineTotal,
        });
      }
      const taxAmount = round2(subtotal * 0.14);
      const total = round2(subtotal + taxAmount);
      const orderNumber = (orderCounters.get(branch.id) ?? 0) + 1;
      orderCounters.set(branch.id, orderNumber);

      await db.order.create({
        data: {
          cafeId: cafe.id,
          branchId: branch.id,
          orderNumber,
          type: n % 2 === 0 ? "DINE_IN" : "TAKEAWAY",
          status: "SERVED",
          source: n % 2 === 0 ? "WAITER" : "CASHIER_POS",
          subtotal,
          taxAmount,
          total,
          createdById: cashier.id,
          createdAt: when,
          completedAt: new Date(when.getTime() + 15 * 60 * 1000),
          items: { create: items },
          payments: {
            create: {
              cafeId: cafe.id,
              amount: total,
              method: methods[n % methods.length],
              receivedById: cashier.id,
              createdAt: new Date(when.getTime() + 10 * 60 * 1000),
            },
          },
        },
      });
    }
  }

  // ── Demo orders for the QR approval workflow ─────────────────
  // Helper: build items + totals for a list of product names.
  const byName = new Map(products.map((p) => [p.name, p]));
  function buildItems(specs: { name: string; qty: number; variant?: string }[]) {
    let subtotal = 0;
    const items = specs.map((spec) => {
      const product = byName.get(spec.name)!;
      const variant = spec.variant
        ? product.variants.find((v) => v.name === spec.variant) ?? null
        : null;
      const unitPrice = round2(
        variant ? Number(variant.price) : Number(product.basePrice)
      );
      const lineTotal = round2(unitPrice * spec.qty);
      subtotal = round2(subtotal + lineTotal);
      return {
        productId: product.id,
        variantId: variant?.id ?? null,
        productName: product.name,
        variantName: variant?.name ?? null,
        unitPrice,
        quantity: spec.qty,
        lineTotal,
      };
    });
    const taxAmount = round2(subtotal * 0.14);
    return { items, subtotal, taxAmount, total: round2(subtotal + taxAmount) };
  }

  async function nextOrderNumber(branchId: string) {
    const n = (orderCounters.get(branchId) ?? 0) + 1;
    orderCounters.set(branchId, n);
    return n;
  }

  const now = Date.now();

  // 1) Two QR menu orders waiting for waiter approval
  for (const demo of [
    {
      customer: "منى أحمد",
      table: "5",
      minsAgo: 8,
      specs: [
        { name: "سبانش لاتيه", qty: 1, variant: "وسط" },
        { name: "براوني", qty: 2 },
      ],
    },
    {
      customer: "عمر خالد",
      table: "12",
      minsAgo: 3,
      specs: [
        { name: "آيس لاتيه", qty: 2, variant: "كبير" },
        { name: "كرواسون", qty: 1 },
      ],
    },
  ]) {
    const built = buildItems(demo.specs);
    const qrOrder = await db.order.create({
      data: {
        cafeId: cafe.id,
        branchId: tagamo3.id,
        orderNumber: await nextOrderNumber(tagamo3.id),
        type: "DINE_IN",
        status: "PENDING_WAITER_APPROVAL",
        source: "QR_MENU",
        customerName: demo.customer,
        tableNumber: demo.table,
        subtotal: built.subtotal,
        taxAmount: built.taxAmount,
        total: built.total,
        createdById: null,
        createdAt: new Date(now - demo.minsAgo * 60_000),
        items: { create: built.items },
      },
    });
    await db.auditLog.create({
      data: {
        cafeId: cafe.id,
        action: "QR_ORDER_SUBMITTED",
        entity: "Order",
        entityId: qrOrder.id,
        details: { orderNumber: qrOrder.orderNumber, customerName: demo.customer },
      },
    });
  }

  // 2) A waiter-created order, already confirmed and in the kitchen
  {
    const built = buildItems([
      { name: "كابتشينو", qty: 2, variant: "وسط" },
      { name: "شاي نعناع", qty: 1 },
    ]);
    const waiterOrder = await db.order.create({
      data: {
        cafeId: cafe.id,
        branchId: tagamo3.id,
        orderNumber: await nextOrderNumber(tagamo3.id),
        type: "DINE_IN",
        status: "CONFIRMED",
        source: "WAITER",
        tableNumber: "3",
        subtotal: built.subtotal,
        taxAmount: built.taxAmount,
        total: built.total,
        createdById: waiter.id,
        createdAt: new Date(now - 6 * 60_000),
        items: { create: built.items },
      },
    });
    await db.auditLog.create({
      data: {
        cafeId: cafe.id,
        userId: waiter.id,
        action: "ORDER_CREATED",
        entity: "Order",
        entityId: waiterOrder.id,
        details: { orderNumber: waiterOrder.orderNumber, source: "WAITER" },
      },
    });
  }

  // 3) A cashier POS order, confirmed and paid
  {
    const built = buildItems([
      { name: "أمريكانو", qty: 1, variant: "كبير" },
      { name: "مافن", qty: 1 },
    ]);
    const posOrder = await db.order.create({
      data: {
        cafeId: cafe.id,
        branchId: tagamo3.id,
        orderNumber: await nextOrderNumber(tagamo3.id),
        type: "TAKEAWAY",
        status: "CONFIRMED",
        source: "CASHIER_POS",
        customerName: "شريف",
        subtotal: built.subtotal,
        taxAmount: built.taxAmount,
        total: built.total,
        createdById: cashier.id,
        createdAt: new Date(now - 4 * 60_000),
        items: { create: built.items },
        payments: {
          create: {
            cafeId: cafe.id,
            amount: built.total,
            method: "CASH",
            receivedById: cashier.id,
          },
        },
      },
    });
    await db.auditLog.create({
      data: {
        cafeId: cafe.id,
        userId: cashier.id,
        action: "ORDER_CREATED",
        entity: "Order",
        entityId: posOrder.id,
        details: { orderNumber: posOrder.orderNumber, source: "CASHIER_POS" },
      },
    });
  }

  // ── Inventory: raw materials for فرع التجمع ──
  const inventorySeed = [
    { name: "بن", category: "قهوة", unit: "KG", currentStock: 12, minimumStock: 3, costPerUnit: 450, supplierName: "محمصة النيل" },
    { name: "لبن", category: "ألبان", unit: "LITER", currentStock: 30, minimumStock: 10, costPerUnit: 38, supplierName: "جهينة" },
    { name: "كاسات", category: "مستهلكات", unit: "PIECE", currentStock: 500, minimumStock: 100, costPerUnit: 2.5 },
    { name: "أغطية", category: "مستهلكات", unit: "PIECE", currentStock: 500, minimumStock: 100, costPerUnit: 1.5 },
    { name: "صوص فانيليا", category: "إضافات", unit: "LITER", currentStock: 5, minimumStock: 2, costPerUnit: 120 },
    { name: "صوص كراميل", category: "إضافات", unit: "LITER", currentStock: 4, minimumStock: 2, costPerUnit: 130 },
    // منخفض عن الحد الأدنى — للاختبار
    { name: "شاي أخضر", category: "مشروبات", unit: "BOX", currentStock: 1, minimumStock: 3, costPerUnit: 85 },
  ] as const;

  for (const item of inventorySeed) {
    const created = await db.inventoryItem.create({
      data: { cafeId: cafe.id, branchId: tagamo3.id, ...item },
    });
    // Opening balance recorded as an initial PURCHASE in the ledger.
    await db.inventoryTransaction.create({
      data: {
        cafeId: cafe.id,
        branchId: tagamo3.id,
        inventoryItemId: created.id,
        type: "PURCHASE",
        quantity: item.currentStock,
        unitCost: item.costPerUnit,
        totalCost: Math.round(item.currentStock * item.costPerUnit * 100) / 100,
        note: "رصيد افتتاحي",
        createdById: owner.id,
      },
    });
  }

  // ── Recipes: link products to inventory ingredients ──
  const invByName = new Map(
    (await db.inventoryItem.findMany({ where: { cafeId: cafe.id } })).map((i) => [
      i.name,
      i,
    ])
  );
  const prodByName = new Map(products.map((p) => [p.name, p]));
  const recipeDefs: Record<string, [string, number, "GRAM" | "ML" | "PIECE" | "BOX"][]> = {
    "إسبريسو": [["بن", 18, "GRAM"]],
    "لاتيه": [["بن", 18, "GRAM"], ["لبن", 200, "ML"], ["كاسات", 1, "PIECE"], ["أغطية", 1, "PIECE"]],
    "سبانش لاتيه": [["بن", 18, "GRAM"], ["لبن", 200, "ML"], ["صوص فانيليا", 20, "ML"], ["كاسات", 1, "PIECE"], ["أغطية", 1, "PIECE"]],
    "آيس لاتيه": [["بن", 18, "GRAM"], ["لبن", 180, "ML"], ["كاسات", 1, "PIECE"], ["أغطية", 1, "PIECE"]],
    "شاي": [["شاي أخضر", 1, "BOX"]],
  };
  const TO_BASE: Record<string, number> = { GRAM: 1, KG: 1000, ML: 1, LITER: 1000, PIECE: 1, BOX: 1, BAG: 1 };
  for (const [prodName, items] of Object.entries(recipeDefs)) {
    const product = prodByName.get(prodName);
    if (!product) continue;
    for (const [ingName, qty, unit] of items) {
      const inv = invByName.get(ingName);
      if (!inv) continue;
      await db.productRecipeItem.create({
        data: { cafeId: cafe.id, productId: product.id, inventoryItemId: inv.id, quantity: qty, unit },
      });
    }
    const rows = await db.productRecipeItem.findMany({
      where: { productId: product.id },
      include: { inventoryItem: { select: { unit: true, costPerUnit: true } } },
    });
    let cost = 0;
    for (const r of rows) {
      const q = (Number(r.quantity) * TO_BASE[r.unit]) / TO_BASE[r.inventoryItem.unit];
      cost += q * Number(r.inventoryItem.costPerUnit);
    }
    await db.product.update({
      where: { id: product.id },
      data: { costPrice: Math.round(cost * 100) / 100 },
    });
  }

  await db.auditLog.create({
    data: {
      cafeId: cafe.id,
      userId: owner.id,
      action: "seed.demo-data",
      entity: "Cafe",
      entityId: cafe.id,
      details: { note: "Demo data generated" },
    },
  });

  console.log("Seeded Egyptian demo data (قهوة المدينة).");
  console.log("  Super admin: admin@cafeops.dev / admin1234");
  console.log("  Owner   أحمد المالك:    owner@qahwa.local / password123 (أو owner@demo.com / owner1234)");
  console.log("  Owner   أحمد المالك:    owner@qahwa.local / password123");
  console.log("  Manager محمد المدير:    manager@demo.com / manager123");
  console.log("  Cashier كريم الكاشير:   cashier@demo.com / cashier123");
  console.log("  Kitchen يوسف الباريستا: kitchen@demo.com / kitchen123");
  console.log("  Waiter  وليد الويتر:    waiter@demo.com  / waiter123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
