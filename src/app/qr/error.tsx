"use client";

import { PublicMenuError } from "@/components/customer-menu/public-error";

export default function QrError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return <PublicMenuError error={error} retry={unstable_retry} />;
}
