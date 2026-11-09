"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import {
  Clock,
  CheckCircle2,
  AlertCircle,
  Clock4,
  Flame,
  Check,
  Receipt,
  AlertTriangle,
} from "lucide-react";

export type StatusChipVariant =
  | "amber"
  | "blue"
  | "emerald"
  | "lavender"
  | "rose"
  | "slate";

interface StatusChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: StatusChipVariant;
  icon?: React.ReactNode;
  label: string;
  size?: "sm" | "default";
}

const variantStyles: Record<StatusChipVariant, { bg: string; text: string; border: string; defaultIcon: React.ReactNode }> = {
  amber: {
    bg: "bg-[#FEF3C7]",
    text: "text-[#B45309]",
    border: "border-[#FCD34D]",
    defaultIcon: <Clock className="size-3.5" aria-hidden="true" />,
  },
  blue: {
    bg: "bg-[#EFF6FF]",
    text: "text-[#1D4ED8]",
    border: "border-[#BFDBFE]",
    defaultIcon: <Clock4 className="size-3.5" aria-hidden="true" />,
  },
  emerald: {
    bg: "bg-[#ECFDF5]",
    text: "text-[#047857]",
    border: "border-[#A7F3D0]",
    defaultIcon: <CheckCircle2 className="size-3.5" aria-hidden="true" />,
  },
  lavender: {
    bg: "bg-[#F5F3FF]",
    text: "text-[#6D28D9]",
    border: "border-[#DDD6FE]",
    defaultIcon: <Receipt className="size-3.5" aria-hidden="true" />,
  },
  rose: {
    bg: "bg-[#FEF2F2]",
    text: "text-[#B91C1C]",
    border: "border-[#FECACA]",
    defaultIcon: <AlertCircle className="size-3.5" aria-hidden="true" />,
  },
  slate: {
    bg: "bg-[#F1F5F9]",
    text: "text-[#475569]",
    border: "border-[#CBD5E1]",
    defaultIcon: <Check className="size-3.5" aria-hidden="true" />,
  },
};

export function StatusChip({
  variant = "slate",
  icon,
  label,
  size = "default",
  className,
  ...props
}: StatusChipProps) {
  const current = variantStyles[variant] || variantStyles.slate;
  const renderedIcon = icon !== undefined ? icon : current.defaultIcon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium whitespace-nowrap transition-colors",
        current.bg,
        current.text,
        current.border,
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs sm:text-sm",
        className
      )}
      {...props}
    >
      {renderedIcon && <span className="shrink-0">{renderedIcon}</span>}
      <span>{label}</span>
    </span>
  );
}

// Preset helper mappings for Task statuses, Priorities, and Expense statuses
export function TaskStatusBadge({ status }: { status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "OVERDUE" }) {
  switch (status) {
    case "OVERDUE":
      return <StatusChip variant="rose" label="متأخرة" icon={<AlertCircle className="size-3.5" />} />;
    case "IN_PROGRESS":
      return <StatusChip variant="blue" label="قيد التنفيذ" icon={<Clock4 className="size-3.5" />} />;
    case "COMPLETED":
      return <StatusChip variant="emerald" label="مكتملة" icon={<CheckCircle2 className="size-3.5" />} />;
    case "PENDING":
    default:
      return <StatusChip variant="amber" label="معلقة" icon={<Clock className="size-3.5" />} />;
  }
}

export function TaskPriorityBadge({ priority }: { priority: "URGENT" | "HIGH" | "MEDIUM" | "ROUTINE" }) {
  switch (priority) {
    case "URGENT":
      return <StatusChip variant="rose" label="عاجل جداً" icon={<Flame className="size-3.5" />} size="sm" />;
    case "HIGH":
      return <StatusChip variant="amber" label="عالي" icon={<AlertTriangle className="size-3.5" />} size="sm" />;
    case "MEDIUM":
      return <StatusChip variant="blue" label="متوسط" size="sm" />;
    case "ROUTINE":
    default:
      return <StatusChip variant="slate" label="روتيني" size="sm" />;
  }
}

export function ExpenseStatusBadge({ status }: { status: "APPROVED" | "PAID" | "PENDING" }) {
  switch (status) {
    case "APPROVED":
      return <StatusChip variant="emerald" label="معتمد" icon={<CheckCircle2 className="size-3.5" />} />;
    case "PAID":
      return <StatusChip variant="blue" label="مدفوع" icon={<Check className="size-3.5" />} />;
    case "PENDING":
    default:
      return <StatusChip variant="amber" label="معلق للاعتماد" icon={<Clock className="size-3.5" />} />;
  }
}
