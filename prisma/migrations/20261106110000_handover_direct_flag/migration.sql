-- Direct shift handover opt-in marker.
-- Additive only: one NOT NULL column with a constant default. Every existing handover reads FALSE
-- (historical and in-progress handovers keep their legacy rules; no cash allocation is invented for them).
-- The close sets it TRUE only for handovers created by the simplified flow.

ALTER TABLE "HandoverSession" ADD COLUMN "directHandover" BOOLEAN NOT NULL DEFAULT false;
