"use client";

import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client";
import { useApp } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The opening half of branch custody, given a door.
 *
 * `POST /api/custody/opening-verification` has existed since SH-22 and had
 * no UI at all. It is ONE route carrying two acts that cost different
 * powers: starting the opening count is `stock_count.start`, and verifying
 * it against the boundary the previous custodian left is `handover.accept`.
 * They are two buttons here for that reason — a single "verify" control
 * would hide the fact that two different people may be required.
 *
 * Ids are typed rather than picked: no endpoint lists shifts awaiting an
 * opening verification, and inventing one is a new API, which this stage
 * does not add.
 */
export function OpeningVerificationPanel() {
  const { canKey, user } = useApp();
  const [shiftId, setShiftId] = useState("");
  const [countSessionId, setCountSessionId] = useState("");
  const [busy, setBusy] = useState(false);

  const mayStart = canKey("stock_count.start");
  const mayVerify = canKey("handover.accept");
  if (!mayStart && !mayVerify) return null;

  async function startCount() {
    setBusy(true);
    try {
      const res = await api<{ countSession: { id: string; reused: boolean } }>(
        "/api/custody/opening-verification",
        {
          method: "POST",
          body: {
            action: "start_count",
            shiftId: shiftId.trim(),
            branchId: user.branchId ?? undefined,
          },
        }
      );
      // The returned id is put where the verify step needs it, so the second
      // half does not depend on somebody copying it correctly.
      setCountSessionId(res.countSession.id);
      toast.success(
        res.countSession.reused ? "في جرد افتتاحي مفتوح بالفعل" : "اتفتح الجرد الافتتاحي"
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر بدء الجرد الافتتاحي");
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    try {
      const res = await api<{ alreadyVerified: boolean; varianceCaseIds: string[] }>(
        "/api/custody/opening-verification",
        {
          method: "POST",
          body: {
            action: "verify",
            shiftId: shiftId.trim(),
            countSessionId: countSessionId.trim(),
            branchId: user.branchId ?? undefined,
          },
        }
      );
      toast.success(
        res.alreadyVerified
          ? "العهدة كانت متحققة قبل كده"
          : `اتحققت العهدة الافتتاحية · حالات فروقات: ${res.varianceCaseIds.length}`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "تعذّر التحقق من العهدة الافتتاحية");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      data-testid="opening-verification-panel"
    >
      <div>
        <h2 className="font-semibold">التحقق من العهدة الافتتاحية</h2>
        <p className="text-xs text-muted-foreground">
          لما الوردية تفتح على عهدة محفوظة في الفرع، لازم تتعد وتتحقق قبل ما تبقى في
          ذمة الوردية.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <Label>معرّف الوردية (shiftId)</Label>
          <Input value={shiftId} onChange={(e) => setShiftId(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label>معرّف الجرد الافتتاحي (countSessionId)</Label>
          <Input
            value={countSessionId}
            onChange={(e) => setCountSessionId(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {mayStart && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || shiftId.trim() === ""}
            onClick={startCount}
            data-testid="opening-verification-start"
          >
            فتح الجرد الافتتاحي
          </Button>
        )}
        {mayVerify && (
          <Button
            size="sm"
            disabled={busy || shiftId.trim() === "" || countSessionId.trim() === ""}
            onClick={verify}
            data-testid="opening-verification-verify"
          >
            تحقّق من العهدة
          </Button>
        )}
      </div>
    </section>
  );
}
