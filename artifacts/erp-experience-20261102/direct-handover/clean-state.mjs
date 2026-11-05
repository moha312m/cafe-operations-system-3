import { PrismaClient } from "@prisma/client";

const db = new PrismaClient({
  datasourceUrl: "postgresql://postgres@127.0.0.1:5434/cafe_ops_test_integr20261101_replay_66515e42c85e8ec4?schema=public"
});

const branchId = "cmw2mhslt0002hlcksjt3cben"; // NEXT CUP Maadi branch
const cafeId = "cmw2mhslr0000hlckihdqwcii";   // NEXT CUP Cafe

async function clean() {
  console.log("=== Resolving and closing all open/awaiting shifts and handovers ===");

  // 1. Resolve Handover cmw2nz1vz03kchlc06l6g03as (Shift 103)
  const handover103 = await db.handoverSession.findUnique({
    where: { id: "cmw2nz1vz03kchlc06l6g03as" },
    include: {
      stockCountSession: {
        include: { lines: true }
      }
    }
  });

  if (handover103) {
    console.log("Found handover cmw2nz1vz03kchlc06l6g03as:", handover103.status);
    const lines = handover103.stockCountSession?.lines ?? [];
    for (const line of lines) {
      await db.handoverStockAcknowledgement.upsert({
        where: {
          handoverId_stockCountLineId: {
            handoverId: handover103.id,
            stockCountLineId: line.id
          }
        },
        create: {
          handoverId: handover103.id,
          stockCountLineId: line.id,
          decision: "ACCEPTED",
          handedOverQuantity: line.countedQuantity ?? 0,
          acknowledgedAt: new Date(),
          acknowledgedById: handover103.outgoingUserId
        },
        update: {
          decision: "ACCEPTED",
          acknowledgedAt: new Date()
        }
      });
      console.log(`Acknowledged stock line ${line.id}`);
    }

    await db.handoverSession.update({
      where: { id: handover103.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        reviewedAt: new Date()
      }
    });
    console.log("Marked handover 103 as COMPLETED");
  }

  // 2. Close all open/awaiting shifts in the branch
  const activeShifts = await db.shift.findMany({
    where: {
      branchId,
      status: { in: ["OPEN", "AWAITING_HANDOVER"] }
    }
  });

  console.log(`Found ${activeShifts.length} active shifts in branch.`);
  for (const s of activeShifts) {
    await db.shift.update({
      where: { id: s.id },
      data: {
        status: "CLOSED",
        closedAt: new Date(),
        financiallyClosedAt: new Date(),
        stockClosedAt: new Date()
      }
    });
    console.log(`Closed shift #${s.shiftNumber} (${s.id})`);
  }

  // 3. Complete any open handovers that belong to this branch
  const openHandovers = await db.handoverSession.findMany({
    where: {
      branchId,
      status: { not: "COMPLETED" }
    }
  });
  console.log(`Found ${openHandovers.length} incomplete handovers in branch.`);
  for (const h of openHandovers) {
    await db.handoverSession.update({
      where: { id: h.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        reviewedAt: new Date()
      }
    });
    console.log(`Marked handover ${h.id} as COMPLETED`);
  }

  // 4. Complete any lingering open custody periods in this branch
  const activeCustodies = await db.custodyPeriod.findMany({
    where: {
      branchId,
      status: "OPEN"
    }
  });
  for (const c of activeCustodies) {
    await db.custodyPeriod.update({
      where: { id: c.id },
      data: {
        status: "CLOSED",
        endedAt: new Date()
      }
    });
    console.log(`Closed custody period ${c.id}`);
  }

  // 5. Verification
  const remainingActiveShifts = await db.shift.count({
    where: {
      branchId,
      status: { in: ["OPEN", "AWAITING_HANDOVER"] }
    }
  });
  const openOrders = await db.order.count({
    where: {
      branchId,
      status: { not: "SERVED" }
    }
  });
  console.log(`\nVerification: Active shifts = ${remainingActiveShifts}, Open/Pending Orders = ${openOrders}`);
}

clean()
  .then(async () => {
    console.log("Cleanup finished successfully!");
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error("Cleanup error:", e);
    await db.$disconnect();
    process.exit(1);
  });
