"use client";
// «مساحة عملي · مهامي» (Figma WS-02, 1743:593 / 1743:1080). The filters and the search live in the URL
// (a reload or a shared link keeps them); opening a task keeps the list, its filters and its scroll — the
// pane opens beside it (1440), over it (1024) or as a sheet (390).
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Btn, FilterChip, OpsBanner, OpsEmpty, OpsError, OpsLoading, useL } from "@/components/ops/ui";
import { PRIORITY_LABEL, PRIORITIES, STATUS_LABEL } from "@/lib/workspace/rules";
import { DueText, PriorityMark, StatusChip, TypeChip, WsPage, WsShell, recordOf, useNow, useSelection, useWs, wsFetch, type Task } from "../_components/kit";
import { CreateTaskDialog, TaskPane } from "../_components/task-ui";

type List = { items: Task[]; next: string | null };
const BUCKETS: [string, string, string][] = [["OVERDUE", "متأخرة", "Overdue"], ["TODAY", "اليوم", "Today"], ["TOMORROW", "غدًا", "Tomorrow"], ["THIS_WEEK", "هذا الأسبوع", "This week"], ["LATER", "لاحقًا", "Later"], ["CLOSED", "مغلقة", "Closed"]];

export default function TasksPage() {
  return <Suspense fallback={null}><Tasks /></Suspense>;
}

function Tasks() {
  const L = useL();
  const now = useNow();
  const router = useRouter();
  const sp = useSearchParams();
  const scope = sp.get("scope") ?? "mine";
  const status = sp.get("status") ?? "open";
  const priority = sp.get("priority") ?? "";
  const due = sp.get("due") ?? "";
  const q = sp.get("q") ?? "";
  const member = sp.get("member") ?? "";
  const [search, setSearch] = useState(q);
  const [taskId, setTaskId] = useSelection("task");
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [extra, setExtra] = useState<{ query: string; items: Task[]; next: string | null } | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [more, setMore] = useState(false);

  const set = (k: string, v: string) => {
    const u = new URLSearchParams(sp.toString());
    if (v) u.set(k, v); else u.delete(k);
    router.replace(`?${u.toString()}`, { scroll: false });
  };
  // The search is written to the URL a moment after typing stops.
  useEffect(() => {
    const t = setTimeout(() => { if (search !== q) set("q", search.trim()); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const query = useMemo(() => new URLSearchParams({ scope: member ? "member" : scope, status, ...(member ? { member } : {}), ...(priority ? { priority } : {}), ...(due ? { due } : {}), ...(q ? { q } : {}) }).toString(), [scope, member, status, priority, due, q]);
  const page = useWs<List>(`/api/workspace/tasks?${query}`);
  const loading = page.loading;
  const error = page.error?.message ?? moreError;
  // The first page from the hook; «عرض المزيد» pages appended while the query is the same.
  const list = useMemo<List | null>(() => (page.data ? (extra && extra.query === query ? { items: [...page.data.items, ...extra.items], next: extra.next } : page.data) : null), [page.data, extra, query]);
  const reload = () => { setExtra(null); setMoreError(null); page.reload(); };

  const loadMore = async () => {
    if (!list?.next) return;
    setMore(true);
    try {
      const d = await wsFetch<List>(`/api/workspace/tasks?${query}&cursor=${encodeURIComponent(list.next)}`);
      setExtra({ query, items: [...(extra && extra.query === query ? extra.items : []), ...d.items], next: d.next });
    } catch (e) { setMoreError(e instanceof Error ? e.message : String(e)); } finally { setMore(false); }
  };

  const grouped = useMemo(() => {
    const m = new Map<string, Task[]>();
    for (const t of list?.items ?? []) {
      const b = t.bucket ?? "CLOSED";
      m.set(b, [...(m.get(b) ?? []), t]);
    }
    return m;
  }, [list]);

  const scopes: [string, string, string][] = [["mine", "مسندة إليّ", "Assigned to me"], ["assigned", "أسندتها", "I assigned"], ["watching", "أتابعها", "Watching"], ["review", "بانتظار مراجعتي", "Awaiting my review"]];
  const changed = (m?: string) => { if (m) setToast(m); reload(); };

  return (
    <WsShell open={!!(taskId)}>
      <WsPage title={L("مهامي", "My tasks")} actions={<Btn variant="primary" onClick={() => setCreating(true)} data-testid="ws-new-task">{L("مهمة جديدة", "New task")}</Btn>} testId="ws-tasks">
        {toast ? <OpsBanner tone="success" onClose={() => setToast(null)}>{toast}</OpsBanner> : null}
        <div className="ws-seg" role="group" aria-label={L("النطاق", "Scope")}>
          {scopes.map(([k, a, e]) => <button key={k} type="button" aria-pressed={!member && scope === k} onClick={() => { const u = new URLSearchParams(sp.toString()); u.delete("member"); if (k === "mine") u.delete("scope"); else u.set("scope", k); router.replace(`?${u.toString()}`, { scroll: false }); }}>{L(a, e)}</button>)}
          {member ? <button type="button" aria-pressed>{list?.items[0]?.assignee.name ?? L("زميل", "Colleague")}</button> : null}
        </div>
        <div className="stk-tool ws-tool">
          <input type="search" className="hr-input hr-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={L("ابحث في المهام أو العملاء", "Search tasks or customers")} aria-label={L("بحث", "Search")} />
          <FilterChip label={L("الحالة", "Status")} value={status === "open" ? "" : status} onChange={(v) => set("status", v || "")} allLabel={L("المفتوحة", "Open")}
            options={[...Object.entries(STATUS_LABEL).filter(([k]) => k !== "DONE" && k !== "CANCELLED").map(([k, v]) => ({ value: k, label: L(v.ar, v.en) })), { value: "done", label: L("المكتملة", "Done") }, { value: "cancelled", label: L("الملغاة", "Cancelled") }, { value: "all", label: L("الكل", "All") }]} />
          <FilterChip label={L("الأولوية", "Priority")} value={priority} onChange={(v) => set("priority", v)} options={PRIORITIES.map((p) => ({ value: p, label: L(PRIORITY_LABEL[p].ar, PRIORITY_LABEL[p].en) }))} />
          <FilterChip label={L("الاستحقاق", "Due")} value={due} onChange={(v) => set("due", v)} options={[{ value: "overdue", label: L("متأخرة", "Overdue") }, { value: "today", label: L("اليوم", "Today") }, { value: "week", label: L("هذا الأسبوع", "This week") }]} />
        </div>

        {error ? <OpsError message={error} onRetry={() => reload()} /> : null}
        {loading && !list ? <OpsLoading /> : null}
        {list && list.items.length === 0 ? (
          <OpsEmpty title={q || priority || due || status !== "open" ? L("لا مهام تطابق هذا البحث", "No tasks match") : scope === "mine" ? L("لا مهام مفتوحة لديك", "You have no open tasks") : L("لا مهام هنا", "Nothing here")}
            body={q || priority || due ? L("غيّر البحث أو الفلاتر.", "Change the search or filters.") : undefined}
            action={scope === "mine" && !q ? <Btn onClick={() => setCreating(true)}>{L("أنشئ مهمة", "Create a task")}</Btn> : undefined} />
        ) : null}
        {list && list.items.length ? (
          <div aria-busy={loading || undefined}>
            {BUCKETS.map(([b, a, e]) => {
              const items = grouped.get(b);
              if (!items?.length) return null;
              return (
                <section key={b} className={`ws-group is-${b.toLowerCase()}`} aria-label={L(a, e)}>
                  <h2 className="ws-group-title">{L(a, e)} <span className="hr-caption">· {items.length}</span></h2>
                  <ul className="ws-rows">
                    {items.map((t) => (
                      <li key={t.id} className={`ws-row${taskId === t.id ? " is-selected" : ""}`}>
                        <TypeChip type={t.kind} />
                        <button type="button" className="ws-row-main" onClick={() => setTaskId(t.id)} aria-current={taskId === t.id || undefined}>
                          <span className="ws-row-title">{t.title}</span>
                          <span className="ws-row-meta">
                            <StatusChip status={t.status} />
                            {recordOf(t) ? <span>{recordOf(t)}</span> : null}
                            {scope !== "mine" ? <span>{t.assignee.name}</span> : null}
                            <DueText dueAt={t.dueAt} overdue={t.overdue} now={now} />
                            <PriorityMark priority={t.priority} />
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {list.next ? <div className="ws-loadmore"><Btn busy={more} onClick={() => void loadMore()}>{L("عرض المزيد", "Show more")}</Btn></div> : null}
          </div>
        ) : null}
      </WsPage>
      {taskId ? <TaskPane id={taskId} onClose={() => setTaskId(null)} onChanged={changed} /> : null}
      {creating ? <CreateTaskDialog onClose={() => setCreating(false)} onCreated={(t, m) => { setCreating(false); setToast(m); reload(); setTaskId(t.id); }} /> : null}
    </WsShell>
  );
}
