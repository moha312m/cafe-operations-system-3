import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://postgres@127.0.0.1:5434/cafe_ops_test_integr20261101_replay_66515e42c85e8ec4?schema=public",
    },
  },
});

const cafeId = "cmw2mhslr0000hlckihdqwcii";
const branchId = "cmw2mhslt0002hlcksjt3cben";

async function main() {
  const owner = await db.user.findFirstOrThrow({ where: { cafeId, role: "CAFE_OWNER" } });

  // Clean up any failed attempts
  await db.recipeItem.deleteMany({ where: { recipe: { cafeId } } });
  await db.recipe.deleteMany({ where: { cafeId } });
  await db.productVariant.deleteMany({ where: { product: { cafeId } } });
  await db.product.deleteMany({ where: { cafeId } });
  await db.menuCategory.deleteMany({ where: { cafeId } });

  // Remove non-original inventory items created earlier
  const originalIds = ["cmw2mhuxs000hhlckgpbqto9t", "cmw2mhuyb000jhlcknelf7nmx"];
  await db.inventoryItem.deleteMany({
    where: {
      cafeId,
      branchId,
      id: { notIn: originalIds },
    },
  });

  // 1. Categories
  const catHot = await db.menuCategory.create({
    data: { cafeId, name: "مشروبات ساخنة", sortOrder: 1 },
  });
  const catCold = await db.menuCategory.create({
    data: { cafeId, name: "مشروبات باردة ومثلجة", sortOrder: 2 },
  });
  const catBakery = await db.menuCategory.create({
    data: { cafeId, name: "مخبوزات وحلويات", sortOrder: 3 },
  });

  // 2. Inventory Items
  // Update existing 2 items with proper cost and higher stock
  const itemEthiopian = await db.inventoryItem.update({
    where: { id: "cmw2mhuxs000hhlckgpbqto9t" },
    data: {
      name: "حبوب بن إسبريسو إثيوبي ييرجاشيف تحميص متوسط مختص",
      unit: "KG",
      currentStock: 25.0,
      costPerUnit: 750.0,
      category: "بن خام",
      isCritical: true,
    },
  });

  const itemMilk = await db.inventoryItem.update({
    where: { id: "cmw2mhuyb000jhlcknelf7nmx" },
    data: {
      name: "حليب أبقار طبيعي طازج كامل الدسم مبستر للباريستا",
      unit: "KG",
      currentStock: 60.0,
      costPerUnit: 42.0,
      category: "ألبان",
      isCritical: true,
    },
  });

  // Create additional raw ingredients
  const itemColombian = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "حبوب بن كولومبي سوبريمو تحميص داكن",
      unit: "KG",
      currentStock: 20.0,
      costPerUnit: 680.0,
      category: "بن خام",
      isCritical: true,
    },
  });

  const itemOatMilk = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "حليب شوفان عضوي خالي من الجلوتين للباريستا",
      unit: "LITER",
      currentStock: 36.0,
      costPerUnit: 110.0,
      category: "ألبان نباتية",
      isCritical: true,
    },
  });

  const itemVanilla = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "سيرب فانيليا مدغشقر طبيعي",
      unit: "ML",
      currentStock: 5000.0,
      costPerUnit: 0.35,
      category: "نكهات وسيرب",
    },
  });

  const itemCaramel = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "سيرب كراميل مملح فرنسي فاخر",
      unit: "ML",
      currentStock: 5000.0,
      costPerUnit: 0.38,
      category: "نكهات وسيرب",
    },
  });

  const itemBelgianChoc = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "صلصة شوكولاتة بلجيكية داكنة",
      unit: "GRAM",
      currentStock: 6000.0,
      costPerUnit: 0.45,
      category: "صلصات وتزيين",
    },
  });

  const itemMatcha = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "مسحوق ماتشا ياباني احتفالي درجة أولى",
      unit: "GRAM",
      currentStock: 2000.0,
      costPerUnit: 2.8,
      category: "شاي وماتشا",
      isCritical: true,
    },
  });

  const itemHotCup = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "أكواب ورقية دبل 12 أونصة مع الأغطية",
      unit: "PIECE",
      currentStock: 800.0,
      costPerUnit: 2.5,
      category: "مستهلكات وتعبئة",
    },
  });

  const itemColdCup = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "أكواب بلاستيكية شفافة مثلجة 16 أونصة",
      unit: "PIECE",
      currentStock: 800.0,
      costPerUnit: 3.0,
      category: "مستهلكات وتعبئة",
    },
  });

  const itemCroissant = await db.inventoryItem.create({
    data: {
      cafeId,
      branchId,
      name: "كرواسون زبدة فرنسي فاخر مجمد للتسوية",
      unit: "PIECE",
      currentStock: 80.0,
      costPerUnit: 28.0,
      category: "مخبوزات مجمدة",
      isCritical: true,
    },
  });

  const TO_BASE = {
    GRAM: 1,
    KG: 1000,
    ML: 1,
    LITER: 1000,
    PIECE: 1,
    BOX: 1,
    BAG: 1,
  };

  function convertQuantity(quantity, from, to) {
    return (quantity * TO_BASE[from]) / TO_BASE[to];
  }

  function recipeFingerprint(items, scope = {}) {
    const body = items
      .map((i) => `${i.inventoryItemId}:${Number(i.quantity)}:${i.unit}:${Number(i.wastePercentage ?? 0)}`)
      .sort()
      .join("|");
    return crypto
      .createHash("sha1")
      .update(`${body}#allVariants=${scope.appliesToAllVariants ? 1 : 0}`)
      .digest("hex");
  }

  function calcCost(items) {
    let sum = 0;
    for (const it of items) {
      const qtyInItemUnit = convertQuantity(Number(it.quantity), it.unit, it.inventoryItem.unit);
      sum += qtyInItemUnit * Number(it.inventoryItem.costPerUnit);
    }
    return Math.round(sum * 100) / 100;
  }

  async function createSkuWithRecipe(cfg) {
    const product = await db.product.create({
      data: {
        cafeId,
        categoryId: cfg.categoryId,
        sku: cfg.sku,
        name: cfg.name,
        description: cfg.description,
        basePrice: cfg.basePrice,
        showInPOS: true,
        showInCustomerMenu: true,
        isAvailable: true,
        sortOrder: cfg.sortOrder,
      },
    });

    if (cfg.variants && cfg.variants.length > 0) {
      for (let i = 0; i < cfg.variants.length; i++) {
        const v = cfg.variants[i];
        await db.productVariant.create({
          data: {
            productId: product.id,
            name: v.name,
            price: v.price,
            sortOrder: i + 1,
            isActive: true,
          },
        });
      }
    }

    const fp = recipeFingerprint(
      cfg.ingredients.map((ing) => ({
        inventoryItemId: ing.item.id,
        quantity: ing.quantity,
        unit: ing.unit,
        wastePercentage: 0,
      })),
      { appliesToAllVariants: true }
    );

    const recipe = await db.recipe.create({
      data: {
        cafeId,
        productId: product.id,
        appliesToAllVariants: true,
        verifiedById: owner.id,
        verifiedAt: new Date(),
        verifiedFingerprint: fp,
        createdById: owner.id,
        items: {
          create: cfg.ingredients.map((ing) => ({
            inventoryItemId: ing.item.id,
            quantity: ing.quantity,
            unit: ing.unit,
            wastePercentage: 0,
          })),
        },
      },
      include: { items: { include: { inventoryItem: true } } },
    });

    const cost = calcCost(recipe.items);
    await db.product.update({
      where: { id: product.id },
      data: { costPrice: cost },
    });

    return { product, recipe, cost };
  }

  // 3. Define the 10 SKUs
  const definitions = [
    {
      sku: "SKU-HOT-ESP-01",
      name: "إسبريسو سينجل / دبل",
      description: "شوت إسبريسو غني ومكثف مستخلص من أجود حبوب البن الإثيوبي المختص",
      categoryId: catHot.id,
      basePrice: 45.0,
      sortOrder: 1,
      variants: [
        { name: "شوت واحد (Single)", price: 45.0 },
        { name: "شوت مضاعف (Double)", price: 60.0 },
      ],
      ingredients: [
        { item: itemEthiopian, quantity: 0.018, unit: "KG" },
        { item: itemHotCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-HOT-AMR-02",
      name: "أمريكانو كلاسيك",
      description: "شوت إسبريسو مزدوج ممزوج بالماء الساخن بنكهة متوازنة ونقية",
      categoryId: catHot.id,
      basePrice: 65.0,
      sortOrder: 2,
      ingredients: [
        { item: itemEthiopian, quantity: 0.018, unit: "KG" },
        { item: itemHotCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-HOT-FLT-03",
      name: "فلات وايت",
      description: "إسبريسو دبل مع حليب مبخر مخملي بطبقة ميكروفوم دقيقة",
      categoryId: catHot.id,
      basePrice: 85.0,
      sortOrder: 3,
      ingredients: [
        { item: itemEthiopian, quantity: 0.018, unit: "KG" },
        { item: itemMilk, quantity: 0.16, unit: "KG" },
        { item: itemHotCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-HOT-CAP-04",
      name: "كابتشينو إيطالي",
      description: "توازن مثالي بين الإسبريسو والحليب المبخر والرغوة الكثيفة الغنية",
      categoryId: catHot.id,
      basePrice: 85.0,
      sortOrder: 4,
      variants: [
        { name: "وسط (Regular - 8oz)", price: 85.0 },
        { name: "كبير (Large - 12oz)", price: 100.0 },
      ],
      ingredients: [
        { item: itemEthiopian, quantity: 0.018, unit: "KG" },
        { item: itemMilk, quantity: 0.2, unit: "KG" },
        { item: itemHotCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-HOT-LAT-05",
      name: "كافيه لاتيه",
      description: "إسبريسو كولومبي فاخر مع حليب طازج مبخر بنعومة وسلاسة",
      categoryId: catHot.id,
      basePrice: 90.0,
      sortOrder: 5,
      variants: [
        { name: "وسط (Regular)", price: 90.0 },
        { name: "كبير (Large)", price: 105.0 },
      ],
      ingredients: [
        { item: itemColombian, quantity: 0.018, unit: "KG" },
        { item: itemMilk, quantity: 0.24, unit: "KG" },
        { item: itemHotCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-HOT-SPC-06",
      name: "سبانش لاتيه ساخن",
      description: "لاتيه غني ممزوج بنكهة الكراميل المملح الفرنسي الفاخر",
      categoryId: catHot.id,
      basePrice: 105.0,
      sortOrder: 6,
      ingredients: [
        { item: itemEthiopian, quantity: 0.018, unit: "KG" },
        { item: itemMilk, quantity: 0.2, unit: "KG" },
        { item: itemCaramel, quantity: 20.0, unit: "ML" },
        { item: itemHotCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-ICE-LAT-07",
      name: "آيس لاتيه فانيليا",
      description: "إسبريسو مثلج منعش مع حليب بارد ونكهة فانيليا مدغشقر الطبيعية",
      categoryId: catCold.id,
      basePrice: 100.0,
      sortOrder: 7,
      ingredients: [
        { item: itemEthiopian, quantity: 0.018, unit: "KG" },
        { item: itemMilk, quantity: 0.22, unit: "KG" },
        { item: itemVanilla, quantity: 25.0, unit: "ML" },
        { item: itemColdCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-ICE-MOC-08",
      name: "آيس موكا شوكولاتة بلجيكية",
      description: "شوكولاتة بلجيكية فاخرة مذابة مع الإسبريسو والحليب والثلج",
      categoryId: catCold.id,
      basePrice: 115.0,
      sortOrder: 8,
      ingredients: [
        { item: itemColombian, quantity: 0.018, unit: "KG" },
        { item: itemMilk, quantity: 0.2, unit: "KG" },
        { item: itemBelgianChoc, quantity: 30.0, unit: "GRAM" },
        { item: itemColdCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-ICE-MAT-09",
      name: "آيس ماتشا لاتيه بحليب الشوفان",
      description: "ماتشا يابانية احتفالية خضراء ممزوجة بحليب الشوفان العضوي والفانيليا",
      categoryId: catCold.id,
      basePrice: 130.0,
      sortOrder: 9,
      ingredients: [
        { item: itemMatcha, quantity: 5.0, unit: "GRAM" },
        { item: itemOatMilk, quantity: 0.25, unit: "LITER" },
        { item: itemVanilla, quantity: 15.0, unit: "ML" },
        { item: itemColdCup, quantity: 1, unit: "PIECE" },
      ],
    },
    {
      sku: "SKU-BAK-CRS-10",
      name: "كرواسون زبدة فرنسي مخبوز طازج",
      description: "كرواسون فرنسي هش ومورق محضر بأجود أنواع الزبدة الطبيعية",
      categoryId: catBakery.id,
      basePrice: 65.0,
      sortOrder: 10,
      ingredients: [{ item: itemCroissant, quantity: 1, unit: "PIECE" }],
    },
  ];

  console.log("Creating 10 SKUs with verified recipes...");
  const results = [];
  for (const def of definitions) {
    const res = await createSkuWithRecipe(def);
    results.push({
      sku: res.product.sku,
      name: res.product.name,
      category:
        def.categoryId === catHot.id
          ? "مشروبات ساخنة"
          : def.categoryId === catCold.id
          ? "مشروبات باردة ومثلجة"
          : "مخبوزات وحلويات",
      price: `${res.product.basePrice} EGP`,
      foodCost: `${res.cost} EGP`,
      margin: `${Math.round(
        ((Number(res.product.basePrice) - res.cost) / Number(res.product.basePrice)) * 100
      )}%`,
      ingredients: res.recipe.items.map((i) => `${i.inventoryItem.name} (${i.quantity} ${i.unit})`),
    });
  }

  console.log("SEEDED_SUCCESSFULLY");
  console.log(JSON.stringify(results, null, 2));
}

main()
  .catch((e) => {
    console.error("SEED_ERROR:", e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
