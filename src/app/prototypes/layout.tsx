import * as React from "react";
import type { Metadata } from "next";
import { PrototypeShell } from "@/components/prototypes/prototype-shell";

export const metadata: Metadata = {
  title: "النماذج البصرية التفاعلية | نكست كب",
  description: "نماذج تصميمية تفاعلية ببيانات حقيقية للموافقة البصرية الشاملة",
};

export default function PrototypesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-[#F6F7F4] text-[#17221E]">
      <PrototypeShell>{children}</PrototypeShell>
    </div>
  );
}
