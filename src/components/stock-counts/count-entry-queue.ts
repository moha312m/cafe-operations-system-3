/** Draft ownership and per-line serialization, independent of row mounting/search. */
export type CountEntry = {
  value: string;
  status: "empty" | "dirty" | "saving" | "saved" | "failed";
  error?: string;
  conflict?: boolean;
};
type SavedLine = { countedQuantity: string | null; effectiveCountedQuantity?: string | null; countedAt: string | null };
type Attempt = { value: string; expectedCountedAt: string | null };
type Entry = CountEntry & { savedValue: string; countedAt: string | null; requested: boolean; failedAttempt?: Attempt };
export function validCountQuantity(value: string): boolean {
  return /^(?:\d+(?:\.\d{0,3})?|\.\d{1,3})$/.test(value.trim()) && Number.isFinite(Number(value));
}
function sameQuantity(a: string, b: string) {
  return a.trim() !== "" && b.trim() !== "" && Number(a) === Number(b);
}
export class CountEntryQueue {
  private entries = new Map<string, Entry>();
  private running = new Map<string, Promise<void>>();
  constructor(
    private write: (id: string, value: number, expectedCountedAt: string | null) => Promise<SavedLine>,
    private changed: () => void = () => {},
    private readCurrent?: (id: string) => Promise<SavedLine>,
  ) {}
  reconcile(lines: Array<SavedLine & { id: string }>) {
    for (const line of lines) {
      const entry = this.entries.get(line.id);
      if (entry && (this.running.has(line.id) || entry.status === "dirty" || entry.status === "failed")) continue;
      if (entry?.countedAt && (!line.countedAt || Date.parse(line.countedAt) < Date.parse(entry.countedAt))) continue;
      const value = (line.effectiveCountedQuantity ?? line.countedQuantity) ?? "";
      this.entries.set(line.id, { value, savedValue: value, countedAt: line.countedAt, requested: false, status: value === "" ? "empty" : "saved" });
    }
  }
  get(id: string): CountEntry | undefined { return this.entries.get(id); }
  edit(id: string, value: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.value = value;
    entry.error = undefined;
    entry.status = this.running.has(id) ? "saving" : !entry.failedAttempt && !entry.conflict && sameQuantity(value, entry.savedValue) ? "saved" : value === "" && entry.savedValue === "" ? "empty" : "dirty";
    this.changed();
  }
  canSubmit(requireComplete = false): boolean {
    return this.running.size === 0 && [...this.entries.values()].every(entry =>
      (entry.status === "saved" || (!requireComplete && entry.status === "empty")) && !entry.failedAttempt && !entry.conflict);
  }
  /** Lines whose typed quantity is not saved yet (a conflict waits for its own review). */
  unsaved(): string[] {
    return [...this.entries].filter(([, entry]) => !entry.conflict && (entry.status === "dirty" || (entry.status === "failed" && !!entry.failedAttempt))).map(([id]) => id);
  }
  /** Saves every unsaved line one after another: the server runs one write per account at a time. */
  async saveAll(): Promise<void> {
    for (const id of this.unsaved()) await this.save(id);
  }
  save(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    entry.requested = true;
    const active = this.running.get(id);
    if (active) return active;
    // Put the promise in the map before dispatching any callbacks.
    const work = Promise.resolve().then(() => this.run(id, entry)).finally(() => { this.running.delete(id); this.changed(); });
    this.running.set(id, work);
    entry.status = "saving";
    this.changed();
    return work;
  }
  private async run(id: string, entry: Entry) {
    while (entry.requested) {
      entry.requested = false;
      if (entry.conflict) {
        try {
          if (!this.readCurrent) throw new Error("حدّث الجرد لمراجعة الدليل الحالي قبل إعادة الحفظ");
          const current = await this.readCurrent(id);
          entry.countedAt = current.countedAt;
          entry.savedValue = current.countedQuantity ?? "";
          entry.conflict = false;
          entry.status = "failed";
          entry.error = "تحدّث الدليل الحالي؛ كميتك محفوظة في الخانة. راجعها ثم أعد الحفظ لتأكيد التعديل";
        } catch (error) {
          entry.status = "failed";
          entry.error = error instanceof Error ? error.message : "تعذّر تحديث الدليل";
        }
        entry.requested = false;
        this.changed();
        return;
      }
      if (!validCountQuantity(entry.value) && !entry.failedAttempt) {
        entry.status = entry.value.trim() === "" && entry.savedValue === "" ? "empty" : "failed";
        entry.error = entry.status === "failed" ? "أدخل كمية غير سالبة حتى ٣ منازل عشرية" : undefined;
        this.changed();
        return;
      }
      if (!entry.failedAttempt && sameQuantity(entry.value, entry.savedValue)) {
        entry.status = "saved"; this.changed(); return;
      }
      const attempt = entry.failedAttempt ?? { value: entry.value, expectedCountedAt: entry.countedAt };
      entry.status = "saving"; entry.error = undefined; this.changed();
      try {
        const saved = await this.write(id, Number(attempt.value), attempt.expectedCountedAt);
        entry.countedAt = saved.countedAt;
        entry.savedValue = saved.countedQuantity ?? attempt.value;
        entry.failedAttempt = undefined;
        entry.status = sameQuantity(entry.value, entry.savedValue) ? "saved" : "dirty";
        // An explicitly requested retry first resolves the uncertain old write,
        // then saves the employee's newer input using its returned version.
        if (entry.status === "dirty" && attempt.value !== entry.value) entry.requested = true;
        this.changed();
      } catch (error) {
        const conflict = typeof error === "object" && error !== null && "status" in error && error.status === 409;
        entry.failedAttempt = conflict ? undefined : attempt;
        entry.conflict = conflict;
        entry.status = "failed";
        entry.error = error instanceof Error ? error.message : "تعذّر الحفظ — أعد المحاولة";
        entry.requested = false;
        this.changed();
        return;
      }
    }
  }
}
