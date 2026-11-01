import { AccountingShell } from "@/components/accounting/accounting-shell";

export default function AccountingLayout({ children }: { children: React.ReactNode }) {
  return <AccountingShell>{children}</AccountingShell>;
}
