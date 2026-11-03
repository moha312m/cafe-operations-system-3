import { JournalEntryView } from "@/components/accounting/journal-entry-view";

export default async function JournalEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JournalEntryView id={id} />;
}
