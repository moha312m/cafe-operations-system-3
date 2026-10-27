import { Prisma } from "@prisma/client";
import { ApiError } from "@/lib/api";

// Shared catalog locks serialize amendment admission with product mode changes.
export async function lockRecipeAmendmentProducts(tx: Prisma.TransactionClient, cafeId: string, positiveLines: readonly { productId: string | null }[]) {
  const ids = [...new Set(positiveLines.flatMap(line => line.productId ? [line.productId] : []))].sort();
  if (!ids.length) return;
  const products = await tx.$queryRaw<{ id: string; stockMode: string }[]>`SELECT "id", "stockMode" FROM "Product" WHERE "cafeId"=${cafeId} AND "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`;
  if (products.length !== ids.length || products.some(product => product.stockMode !== "RECIPE")) {
    throw new ApiError(409, "Product stock settings changed. Restore the recipe setting or cancel this amendment before continuing.");
  }
}

export async function assertNoPendingRecipeAmendments(tx: Prisma.TransactionClient, cafeId: string, productId: string) {
  const pending = await tx.orderAmendment.findFirst({
    where: { cafeId, OR: [{ status: { notIn: ["COMMITTED", "CANCELLED"] } }, { status: "COMMITTED", kitchenStatus: "PENDING" }], proposed: { path: ["positiveLines"], array_contains: [{ productId }] } },
    select: { id: true },
  });
  if (pending) throw new ApiError(409, "Complete or cancel this product's pending recipe amendments before switching to finished goods.");
}
