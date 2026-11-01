import { CustomerDisplay } from "@/components/display/customer-display";

export const dynamic = "force-dynamic";

// شاشة العملاء — full screen, no sidebar: meant for a TV facing the room,
// logged in on that device. ?branchId= picks the branch for owners.
export default async function DisplayPage({ searchParams }: { searchParams: Promise<{ branchId?: string }> }) {
  const { branchId } = await searchParams;
  return <CustomerDisplay initialBranchId={branchId ?? null} />;
}
