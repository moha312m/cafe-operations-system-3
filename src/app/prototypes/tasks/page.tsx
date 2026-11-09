"use client";

import * as React from "react";
import {
  MOCK_TASKS,
  type TaskItem,
  type TaskStatus,
} from "../_data/mock-data";
import {
  TaskStatusBadge,
  TaskPriorityBadge,
} from "@/components/prototypes/status-chip";
import {
  CheckSquare,
  Clock,
  Building2,
  User,
  Search,
  CheckCircle2,
  AlertCircle,
  X,
  UploadCloud,
  FileCheck2,
  MessageSquare,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function TasksPrototypePage() {
  const [tasks, setTasks] = React.useState<TaskItem[]>([...MOCK_TASKS]);
  const [selectedTaskId, setSelectedTaskId] = React.useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedBranch, setSelectedBranch] = React.useState<string>("all");
  const [selectedRole, setSelectedRole] = React.useState<string>("all");
  const [selectedStatus, setSelectedStatus] = React.useState<string>("all");

  // Evidence Mock State in Drawer
  const [mockEvidenceUploaded, setMockEvidenceUploaded] = React.useState<boolean>(false);
  const [evidenceNotes, setEvidenceNotes] = React.useState<string>("");

  const selectedTask = React.useMemo(() => {
    return tasks.find((t) => t.id === selectedTaskId) || null;
  }, [tasks, selectedTaskId]);

  // Open Task Drawer
  const handleOpenTask = (task: TaskItem) => {
    setSelectedTaskId(task.id);
    setMockEvidenceUploaded(!!task.evidenceMockImage);
    setEvidenceNotes(task.evidenceNotesAr || "");
  };

  // Toggle Single Checklist Item
  const handleToggleChecklistItem = (taskId: string, checkItemId: string) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id === taskId) {
          const nextChecklist = task.checklist.map((item) =>
            item.id === checkItemId ? { ...item, isDone: !item.isDone } : item
          );

          // State transition rules:
          // 1. All items done (and count > 0) -> COMPLETED
          // 2. Overdue task with incomplete items -> retain OVERDUE urgency badge
          // 3. Any items done (>0) -> IN_PROGRESS (reverts COMPLETED back to IN_PROGRESS)
          // 4. Zero items done (0) -> PENDING (reverts COMPLETED or IN_PROGRESS back to PENDING)
          const allDone = nextChecklist.length > 0 && nextChecklist.every((c) => c.isDone);
          const anyDone = nextChecklist.some((c) => c.isDone);

          let newStatus: TaskStatus = task.status;
          if (allDone) {
            newStatus = "COMPLETED";
          } else if (task.status === "OVERDUE") {
            newStatus = "OVERDUE";
          } else if (anyDone) {
            newStatus = "IN_PROGRESS";
          } else {
            newStatus = "PENDING";
          }

          return {
            ...task,
            checklist: nextChecklist,
            status: newStatus,
          };
        }
        return task;
      })
    );
  };

  // Mark Full Task Complete
  const handleCompleteTask = (taskId: string) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id === taskId) {
          return {
            ...task,
            status: "COMPLETED" as TaskStatus,
            checklist: task.checklist.map((c) => ({ ...c, isDone: true })),
            evidenceNotesAr: evidenceNotes || "تم استيفاء جميع المتطلبات بنجاح.",
            evidenceMockImage: mockEvidenceUploaded
              ? "evidence_photo_uploaded.jpg"
              : undefined,
          };
        }
        return task;
      })
    );

    toast.success("تم اعتماد وإكمال المهمة بنجاح وتوثيق سجل الإثبات");
    setSelectedTaskId(null);
  };

  // Filtered Tasks
  const filteredTasks = React.useMemo(() => {
    return tasks.filter((t) => {
      const matchSearch =
        searchQuery === "" ||
        t.titleAr.includes(searchQuery) ||
        t.assigneeName.includes(searchQuery) ||
        t.code.toLowerCase().includes(searchQuery.toLowerCase());
      const matchBranch =
        selectedBranch === "all" || t.branchName === selectedBranch;
      const matchRole =
        selectedRole === "all" || t.roleAr === selectedRole;
      const matchStatus =
        selectedStatus === "all" || t.status === selectedStatus;

      return matchSearch && matchBranch && matchRole && matchStatus;
    });
  }, [tasks, searchQuery, selectedBranch, selectedRole, selectedStatus]);

  // Counts
  const counts = React.useMemo(() => {
    return {
      total: tasks.length,
      pending: tasks.filter((t) => t.status === "PENDING").length,
      inProgress: tasks.filter((t) => t.status === "IN_PROGRESS").length,
      completed: tasks.filter((t) => t.status === "COMPLETED").length,
      overdue: tasks.filter((t) => t.status === "OVERDUE").length,
    };
  }, [tasks]);

  return (
    <div className="flex flex-col gap-6 w-full">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-[#E2E4DE] pb-4">
        <div>
          <h1 className="font-heading text-2xl font-bold tracking-tight text-[#17221E]">
            قوائم المهام والتحقق التشغيلية (Operational Tasks)
          </h1>
          <p className="text-sm text-[#64746B]">
            متابعة المعايرة الصباحية، التعقيم، جرد الثلاجات، وتوثيق إثباتات الإنجاز بالصور
          </p>
        </div>

        {/* Status Counters Chips */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-xl border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700">
            <AlertCircle className="size-3.5" />
            <span>{counts.overdue} متأخرة</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-bold text-blue-700">
            <Clock className="size-3.5" />
            <span>{counts.inProgress} قيد التنفيذ</span>
          </div>

          <div className="flex items-center gap-1.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
            <CheckCircle2 className="size-3.5" />
            <span>{counts.completed} مكتملة</span>
          </div>
        </div>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row gap-3 rounded-2xl bg-white p-3 border border-[#E2E4DE]">
        <div className="relative flex-1">
          <Search className="absolute start-3.5 top-1/2 -translate-y-1/2 size-4 text-[#64746B]" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="ابحث بعنوان المهمة، الموظف المكلف، أو كود TSK..."
            className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white pe-4 ps-10 text-xs sm:text-sm outline-none focus:border-[#27695B]"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          {/* Branch Filter */}
          <select
            value={selectedBranch}
            onChange={(e) => setSelectedBranch(e.target.value)}
            className="min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs font-medium text-[#17221E] outline-none focus:border-[#27695B]"
          >
            <option value="all">جميع الفروع</option>
            <option value="فرع وسط البلد">فرع وسط البلد</option>
            <option value="فرع التجمع الخامس">فرع التجمع الخامس</option>
            <option value="فرع الشيخ زايد">فرع الشيخ زايد</option>
          </select>

          {/* Role Filter */}
          <select
            value={selectedRole}
            onChange={(e) => setSelectedRole(e.target.value)}
            className="min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs font-medium text-[#17221E] outline-none focus:border-[#27695B]"
          >
            <option value="all">جميع الأدوار</option>
            <option value="باريستا">باريستا</option>
            <option value="مشرف الوردية">مشرف الوردية</option>
            <option value="فريق النظافة">فريق النظافة</option>
          </select>

          {/* Status Filter */}
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs font-medium text-[#17221E] outline-none focus:border-[#27695B]"
          >
            <option value="all">جميع الحالات</option>
            <option value="OVERDUE">متأخرة</option>
            <option value="IN_PROGRESS">قيد التنفيذ</option>
            <option value="PENDING">معلقة</option>
            <option value="COMPLETED">مكتملة</option>
          </select>
        </div>
      </div>

      {/* Tasks List */}
      <div className="flex flex-col gap-3">
        {filteredTasks.map((task) => {
          const completedCount = task.checklist.filter((c) => c.isDone).length;
          const totalCount = task.checklist.length;
          const percent =
            totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);

          return (
            <div
              key={task.id}
              onClick={() => handleOpenTask(task)}
              className={cn(
                "group flex flex-col sm:flex-row sm:items-center justify-between gap-4 rounded-2xl border p-4 bg-white shadow-2xs hover:border-[#27695B] hover:shadow-sm cursor-pointer transition-all",
                task.status === "OVERDUE" ? "border-rose-200" : "border-[#E2E4DE]"
              )}
            >
              {/* Left Details in RTL */}
              <div className="flex items-start gap-3.5">
                <div
                  className={cn(
                    "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl",
                    task.status === "COMPLETED"
                      ? "bg-emerald-100 text-emerald-700"
                      : task.status === "OVERDUE"
                      ? "bg-rose-100 text-rose-700"
                      : task.status === "IN_PROGRESS"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-[#F6F7F4] text-[#64746B]"
                  )}
                >
                  <CheckSquare className="size-5" />
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-bold text-[#64746B]" dir="ltr">
                      {task.code}
                    </span>
                    <h3 className="font-heading text-sm sm:text-base font-bold text-[#17221E] group-hover:text-[#27695B] transition-colors">
                      {task.titleAr}
                    </h3>
                    <TaskPriorityBadge priority={task.priority} />
                  </div>

                  <p className="line-clamp-2 text-xs text-[#64746B] leading-relaxed max-w-2xl">
                    {task.descriptionAr}
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[#64746B]">
                    <span className="flex items-center gap-1">
                      <Building2 className="size-3.5 text-[#27695B]" />
                      <span>{task.branchName}</span>
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1">
                      <User className="size-3.5" />
                      <span>{task.assigneeName} ({task.roleAr})</span>
                    </span>
                    <span>•</span>
                    <span className="flex items-center gap-1 text-rose-600 font-medium">
                      <Clock className="size-3.5" />
                      <span>الموعد: {task.dueTimeAr}</span>
                    </span>
                  </div>
                </div>
              </div>

              {/* Right Checklist Progress & Status Badge */}
              <div className="flex sm:flex-col items-center sm:items-end justify-between border-t sm:border-t-0 border-[#F6F7F4] pt-2 sm:pt-0 gap-2 shrink-0">
                <TaskStatusBadge status={task.status} />

                <div className="flex flex-col items-end gap-1">
                  <span className="text-[11px] font-semibold text-[#64746B]">
                    قائمة التحقق: {completedCount} / {totalCount} ({percent}%)
                  </span>
                  <div className="h-1.5 w-24 rounded-full bg-[#F6F7F4] overflow-hidden">
                    <div
                      style={{ width: `${percent}%` }}
                      className={cn(
                        "h-full rounded-full transition-all",
                        percent === 100 ? "bg-emerald-500" : "bg-[#27695B]"
                      )}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}

        {filteredTasks.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-[#E2E4DE] bg-white p-12 text-center">
            <CheckSquare className="size-12 text-[#8D9B93] mb-3" />
            <p className="font-heading text-base font-bold text-[#17221E]">
              لا توجد مهام مطابقة لخيارات البحث أو التصفية
            </p>
          </div>
        )}
      </div>

      {/* Interactive Task Detail Drawer (sm:max-w-2xl to prevent clamping) */}
      {selectedTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs"
          onClick={() => setSelectedTaskId(null)}
        >
          <div
            className="flex w-full sm:max-w-2xl flex-col rounded-3xl bg-white p-5 sm:p-6 shadow-2xl animate-in zoom-in-95 duration-150 max-h-[90vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="flex items-start justify-between border-b border-[#E2E4DE] pb-4">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-[#27695B]" dir="ltr">
                    {selectedTask.code}
                  </span>
                  <TaskPriorityBadge priority={selectedTask.priority} />
                  <TaskStatusBadge status={selectedTask.status} />
                </div>
                <h3 className="font-heading text-lg font-bold text-[#17221E] mt-1">
                  {selectedTask.titleAr}
                </h3>
              </div>

              <button
                type="button"
                onClick={() => setSelectedTaskId(null)}
                aria-label="إغلاق تفاصيل المهمة"
                className="flex size-11 shrink-0 items-center justify-center rounded-full text-[#64746B] hover:bg-[#F6F7F4] transition-colors"
              >
                <X className="size-5" />
              </button>
            </div>

            {/* Drawer Body (Scrollable) */}
            <div className="flex-1 overflow-y-auto py-4 space-y-4">
              {/* Meta Card */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-2xl bg-[#F6F7F4] p-3 text-xs">
                <div>
                  <span className="text-[#64746B] block">الفرع:</span>
                  <span className="font-bold text-[#17221E]">{selectedTask.branchName}</span>
                </div>
                <div>
                  <span className="text-[#64746B] block">المكلف بالتنفيذ:</span>
                  <span className="font-bold text-[#17221E]">
                    {selectedTask.assigneeName} ({selectedTask.roleAr})
                  </span>
                </div>
                <div>
                  <span className="text-[#64746B] block">الموعد المستهدف:</span>
                  <span className="font-bold text-rose-600">{selectedTask.dueTimeAr}</span>
                </div>
              </div>

              {/* Description */}
              <div>
                <h4 className="text-xs font-bold text-[#17221E] mb-1">
                  تعليمات وإجراءات المهمة:
                </h4>
                <p className="text-xs text-[#64746B] leading-relaxed bg-white border border-[#E2E4DE] p-3 rounded-xl">
                  {selectedTask.descriptionAr}
                </p>
              </div>

              {/* Supervisor Note Banner if any */}
              {selectedTask.supervisorNoteAr && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 flex items-start gap-2.5">
                  <MessageSquare className="size-4 text-amber-700 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block">ملاحظة المشرف:</span>
                    <span>{selectedTask.supervisorNoteAr}</span>
                  </div>
                </div>
              )}

              {/* Interactive Checklist Section */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-[#17221E]">
                    بنود قائمة التحقق (انقر للتأشير والإنجاز):
                  </h4>
                  <span className="font-mono text-xs font-bold text-[#27695B]">
                    {selectedTask.checklist.filter((c) => c.isDone).length} / {selectedTask.checklist.length} مكتمل
                  </span>
                </div>

                {/* Progress bar */}
                <div className="h-2 w-full rounded-full bg-[#F6F7F4] overflow-hidden">
                  <div
                    style={{
                      width: `${
                        selectedTask.checklist.length === 0
                          ? 0
                          : Math.round(
                              (selectedTask.checklist.filter((c) => c.isDone).length /
                                selectedTask.checklist.length) *
                                100
                            )
                      }%`,
                    }}
                    className="h-full rounded-full bg-[#27695B] transition-all duration-300"
                  />
                </div>

                <div className="space-y-1.5 pt-1">
                  {selectedTask.checklist.map((item) => (
                    <label
                      key={item.id}
                      className={cn(
                        "flex items-center gap-3 rounded-xl border p-3 text-xs font-medium cursor-pointer transition-all min-h-[48px]",
                        item.isDone
                          ? "border-emerald-200 bg-emerald-50/40 text-emerald-900"
                          : "border-[#E2E4DE] bg-white text-[#17221E] hover:bg-[#F6F7F4]"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={item.isDone}
                        onChange={() =>
                          handleToggleChecklistItem(selectedTask.id, item.id)
                        }
                        className="size-5 rounded border-[#8D9B93] text-[#27695B] focus:ring-[#27695B] accent-[#27695B]"
                      />
                      <span className={cn(item.isDone && "line-through text-[#64746B]")}>
                        {item.textAr}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              {/* Evidence Section */}
              {selectedTask.evidenceRequired && (
                <div className="space-y-2 border-t border-[#E2E4DE] pt-3">
                  <h4 className="text-xs font-bold text-[#17221E]">
                    إثبات التنفيذ المطلوب (صورة / مذكرة):
                  </h4>

                  <div
                    onClick={() => {
                      setMockEvidenceUploaded(!mockEvidenceUploaded);
                      toast.info(
                        mockEvidenceUploaded
                          ? "تمت إزالة صورة الإثبات"
                          : "تم إرفاق صورة الإثبات بنجاح"
                      );
                    }}
                    className={cn(
                      "flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-4 text-center cursor-pointer transition-colors min-h-[70px]",
                      mockEvidenceUploaded
                        ? "border-emerald-500 bg-emerald-50/60"
                        : "border-[#E2E4DE] hover:border-[#27695B] bg-[#F6F7F4]/40"
                    )}
                  >
                    {mockEvidenceUploaded ? (
                      <div className="flex items-center gap-2 text-emerald-700 font-bold text-xs">
                        <CheckCircle2 className="size-5" />
                        <span>تم توثيق صورة الإثبات بنجاح (evidence_dial_in.jpg) - انقر للتعديل</span>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-1 text-[#64746B]">
                        <UploadCloud className="size-6 text-[#27695B]" />
                        <span className="text-xs font-semibold text-[#17221E]">
                          اضغط لالتقاط أو إرفاق صورة إثبات المعايرة والنظافة
                        </span>
                      </div>
                    )}
                  </div>

                  <input
                    type="text"
                    value={evidenceNotes}
                    onChange={(e) => setEvidenceNotes(e.target.value)}
                    placeholder="ملاحظات الباريستا أو المشرف حول القراءات..."
                    className="w-full min-h-[44px] rounded-xl border border-[#E2E4DE] bg-white px-3 text-xs outline-none focus:border-[#27695B]"
                  />
                </div>
              )}
            </div>

            {/* Drawer Actions */}
            <div className="border-t border-[#E2E4DE] pt-4 flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setSelectedTaskId(null)}
                className="min-h-[44px] rounded-xl border border-[#E2E4DE] px-4 text-xs font-bold text-[#17221E] hover:bg-[#F6F7F4]"
              >
                إغلاق
              </button>

              <button
                type="button"
                onClick={() => handleCompleteTask(selectedTask.id)}
                className="min-h-[44px] flex items-center gap-2 rounded-xl bg-[#27695B] px-6 text-xs font-bold text-white shadow-md hover:bg-[#1e5348] active:scale-98 transition-all"
              >
                <FileCheck2 className="size-4" />
                <span>اعتماد وإكمال المهمة</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
