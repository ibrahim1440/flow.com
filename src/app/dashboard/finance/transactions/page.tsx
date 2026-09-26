"use client";

import { useEffect, useMemo, useState } from "react";
import { Upload, Plus, ArrowLeftRight, Search, X, Paperclip, Trash2, Link2, CheckCircle2, Scale } from "lucide-react";
import { useUser } from "../../user-context";
import { ALL_CLASSES, CLASS_LABELS, classDirection, isAllocatableClass, SETTLEMENT_CLASSES, type TxnClass } from "@/lib/finance/classes";
import { parseMoney } from "@/lib/finance/money";
import { riyadhDateString } from "@/lib/finance/dates";
import { Badge, Button, Card, CardTitle, Dialog, EmptyState, ErrorState, Field, INPUT, LoadingState, Notice, Segmented, Table, Td, Th, api, useApi, useFinance, useHasSub, useIdempotencyKey, useL, withBranch, type Tone } from "../_components/ui";
import { ImportDialog } from "./import-dialog";

type Account = { id: string; code: string; nameEn: string; nameAr: string | null; branchKey: string; isRestricted: boolean; type?: string };
type FinCat = { id: string; code: string; nameEn: string; nameAr: string | null; kind: "RECEIPT" | "PAYMENT"; active: boolean };
type Row = {
  id: string; txnDate: string; amount: string; status: string; classification: TxnClass; reviewStatus: string; description: string | null;
  bankReference: string | null; possibleDuplicateOfId: string | null; cashAccount: { code: string; nameEn: string; nameAr: string | null };
};
type Detail = {
  transaction: Row & { grossAmount: string | null; feeAmount: string | null; counterparty: string | null; reviewNote: string | null; reconciliationId: string | null; cashAccountId: string; transferPeerId: string | null; source: string; statementConfirmedAt: string | null; splits: { finCategoryId: string; amount: string; note: string | null }[]; matches: { id: string; targetType: string; targetId: string; amount: string; taxAmount: string; active: boolean }[]; createdBy: string | null; reviewedBy: string | null; reviewedAt: string | null };
  entries: { id: string; entryType: string; amount: string; category: { code: string; nameEn: string; nameAr: string | null }; createdAt: string }[];
  attachments: { id: string; fileName: string; sizeBytes: number; createdAt: string }[];
  run: { id: string } | null; unallocated: number; possibleDuplicate: { id: string; txnDate: string; amount: string; bankReference: string | null; description: string | null } | null;
  audits: { id: string; action: string; createdAt: string; userId: string | null; reason: string | null }[];
  people: { id: string; name: string }[];
};

const toMinor = (s: string | number) => Math.round(Number(s) * 100);

function reviewTone(r: Row): [string, string, Tone] {
  if (r.status === "VOID") return ["ملغى", "Void", "info"];
  if (r.status === "PENDING") return ["معلّقة", "Pending", "info"];
  if (r.reviewStatus === "NEEDS_REVIEW") return ["بحاجة لمراجعة", "Needs review", "warn"];
  return ["مُراجعة", "Reviewed", "ok"];
}

export default function TransactionsPage() {
  const { L, name, money } = useL();
  const user = useUser();
  const { branch, refresh } = useFinance();
  const canEnter = useHasSub(user?.permissions, "txn_enter");
  const canRecon = useHasSub(user?.permissions, "reconcile");
  const [filter, setFilter] = useState<"all" | "review" | "pending">("all");
  const [accountId, setAccountId] = useState("");
  const [q, setQ] = useState("");
  const [qDebounced, setQD] = useState("");
  const [skip, setSkip] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"manual" | "transfer" | "import" | null>(null);
  useEffect(() => { const t = setTimeout(() => { setQD(q); setSkip(0); }, 300); return () => clearTimeout(t); }, [q]);

  const params = new URLSearchParams({ take: "10", skip: String(skip) });
  if (filter === "review") params.set("review", "NEEDS_REVIEW");
  if (filter === "pending") params.set("status", "PENDING");
  if (accountId) params.set("accountId", accountId);
  if (qDebounced) params.set("q", qDebounced);
  const list = useApi<{ rows: Row[]; total: number }>(`/api/finance/transactions?${params}`);
  const counts = useApi<{ total: number }>("/api/finance/transactions?review=NEEDS_REVIEW&take=1");
  const pend = useApi<{ total: number }>("/api/finance/transactions?status=PENDING&take=1");
  const accounts = useApi<Account[]>("/api/finance/accounts");
  const setup = useApi<{ finCategories: FinCat[] }>("/api/finance/setup");
  const done = () => { list.reload(); counts.reload(); pend.reload(); refresh(); };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-2 flex-wrap">
        <Segmented value={filter} onChange={(v) => { setFilter(v); setSkip(0); }} options={[
          { value: "all", label: L("الكل", "All") },
          { value: "review", label: L(`بحاجة لمراجعة (${counts.data?.total ?? 0})`, `Needs review (${counts.data?.total ?? 0})`) },
          { value: "pending", label: L(`معلّقة (${pend.data?.total ?? 0})`, `Pending (${pend.data?.total ?? 0})`) },
        ]} />
        <select aria-label={L("الحساب", "Account")} className={`${INPUT} !w-auto`} value={accountId} onChange={(e) => { setAccountId(e.target.value); setSkip(0); }}>
          <option value="">{L("كل الحسابات", "All accounts")}</option>
          {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}
        </select>
        <div className="relative flex-1 min-w-[220px]">
          <Search size={14} className="absolute top-1/2 -translate-y-1/2 start-3 text-brown-light" />
          <input className={`${INPUT} ps-8`} placeholder={L("بحث بالوصف أو المرجع أو الطرف", "Search description, reference or counterparty")} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <div className={`grid gap-4 items-start ${selected ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_400px]" : "grid-cols-1"}`}>
        <Card pad="p-4">
          <CardTitle
            title={L("السطور البنكية والنقدية", "Bank and cash lines")}
            sub={L(`${list.data?.total ?? 0} سطراً · بحاجة لمراجعة ${counts.data?.total ?? 0} · معلّقة ${pend.data?.total ?? 0}`, `${list.data?.total ?? 0} lines · needs review ${counts.data?.total ?? 0} · pending ${pend.data?.total ?? 0}`)}
            right={canEnter && <>
              <Button kind="primary" icon={Upload} onClick={() => setDialog("import")}>{L("استيراد CSV", "Import CSV")}</Button>
              <Button icon={Plus} onClick={() => setDialog("manual")}>{L("قيد يدوي", "Manual entry")}</Button>
              <Button icon={ArrowLeftRight} onClick={() => setDialog("transfer")}>{L("تحويل", "Transfer")}</Button>
            </>}
          />
          {list.loading && !list.data ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : list.data && list.data.rows.length === 0 ? (
            <EmptyState title={filter === "all" && !qDebounced ? L("لا توجد سطور بعد", "No lines yet") : L("لا توجد سطور مطابقة", "No matching lines")} body={filter === "all" && !qDebounced ? L("استورد كشفاً بنكياً أو أضف قيداً يدوياً.", "Import a bank statement or add a manual entry.") : undefined} />
          ) : list.data && (
            <>
              <Table>
                <thead><tr><Th>{L("التاريخ", "Date")}</Th><Th>{L("الوصف", "Description")}</Th><Th>{L("التصنيف", "Classification")}</Th><Th>{L("المراجعة", "Review")}</Th><Th num>{L("المبلغ", "Amount")}</Th></tr></thead>
                <tbody>
                  {list.data.rows.map((r) => {
                    const [ar, en, tone] = reviewTone(r);
                    const amt = toMinor(r.amount);
                    return (
                      <tr key={r.id} onClick={() => setSelected(r.id)} className={`cursor-pointer ${selected === r.id ? "bg-orange-light" : "hover:bg-cream"}`}>
                        <Td className="text-brown whitespace-nowrap">{r.txnDate.slice(0, 10)}</Td>
                        <Td className="max-w-[1px] w-full">
                          <p className="font-medium truncate">{r.description ?? "—"}</p>
                          <p className="text-[11px] text-brown-light truncate">{r.cashAccount.code}{r.bankReference ? ` · ${r.bankReference}` : ""}{r.possibleDuplicateOfId ? ` · ${L("تكرار محتمل", "possible duplicate")}` : ""}</p>
                        </Td>
                        <Td className="whitespace-nowrap">{r.classification === "UNCLASSIFIED" ? <Badge tone="warn">{L("غير مصنفة", "Unclassified")}</Badge> : L(CLASS_LABELS[r.classification].ar, CLASS_LABELS[r.classification].en)}</Td>
                        <Td><Badge tone={tone}>{L(ar, en)}</Badge></Td>
                        <Td num className={`font-bold ${r.status === "VOID" ? "line-through text-brown-light" : amt > 0 ? "text-green-600" : "text-charcoal"}`}>{money(amt)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-brown">{L(`عرض ${Math.min(skip + 1, list.data.total)}–${Math.min(skip + 10, list.data.total)} من ${list.data.total}`, `Showing ${Math.min(skip + 1, list.data.total)}–${Math.min(skip + 10, list.data.total)} of ${list.data.total}`)}</span>
                <div className="flex gap-1.5">
                  <Button disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - 10))}>{L("السابق", "Previous")}</Button>
                  <Button disabled={skip + 10 >= list.data.total} onClick={() => setSkip(skip + 10)}>{L("التالي", "Next")}</Button>
                </div>
              </div>
            </>
          )}
        </Card>

        {selected && <ReviewPanel id={selected} finCats={setup.data?.finCategories ?? []} canEnter={canEnter} onClose={() => setSelected(null)} onChanged={done} />}
      </div>

      <ReconciliationCard accounts={accounts.data ?? []} canRecon={canRecon} onDone={done} />

      <ManualDialog open={dialog === "manual"} onClose={() => setDialog(null)} accounts={accounts.data ?? []} onDone={done} />
      <TransferDialog open={dialog === "transfer"} onClose={() => setDialog(null)} accounts={accounts.data ?? []} onDone={done} />
      <ImportDialog open={dialog === "import"} onClose={() => setDialog(null)} accounts={accounts.data ?? []} onDone={done} branch={branch} />
    </div>
  );
}

// ─── Review panel ────────────────────────────────────────────────────────────

type PanelProps = { id: string; finCats: FinCat[]; canEnter: boolean; onClose: () => void; onChanged: () => void };

function ReviewPanel(props: PanelProps) {
  const d = useApi<Detail>(`/api/finance/transactions/${props.id}`);
  if ((d.loading && !d.data) || (d.data && d.data.transaction.id !== props.id)) return <LoadingState />;
  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  if (!d.data) return null;
  const t = d.data.transaction;
  // Remount the form whenever the saved line changes, so its fields start from the server.
  return <ReviewForm key={`${t.id}:${t.status}:${t.reviewStatus}:${t.classification}:${d.data.audits[0]?.id ?? ""}`} {...props} data={d.data} reload={d.reload} />;
}

function ReviewForm({ id, finCats, canEnter, onClose, onChanged, data, reload }: PanelProps & { data: Detail; reload: () => void }) {
  const { L, name, money, sar } = useL();
  const user = useUser();
  const { branch } = useFinance();
  const canAllocate = useHasSub(user?.permissions, "allocate");
  const d = { data, reload };
  const t = data.transaction;
  const [cls, setCls] = useState<TxnClass>(t.classification);
  const [splits, setSplits] = useState<{ finCategoryId: string; amount: string }[]>(() => (t.splits.length ? t.splits.map((s) => ({ finCategoryId: s.finCategoryId, amount: s.amount })) : [{ finCategoryId: "", amount: Number(t.amount).toFixed(2) }]));
  const [gross, setGross] = useState(t.grossAmount ?? ""); const [fee, setFee] = useState(t.feeAmount ?? "");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReverse, setConfirmReverse] = useState(false);
  const [matchQ, setMatchQ] = useState(""); const [cands, setCands] = useState<{ kind: string; note?: string; rows: { id: string; label: string; labelAr?: string; matched?: number; amount?: number; dueDate?: string }[] } | null>(null);
  const [matchPick, setMatchPick] = useState<{ id: string; label: string } | null>(null);
  const [matchAmt, setMatchAmt] = useState(""); const [matchTax, setMatchTax] = useState("");

  useEffect(() => {
    const h = setTimeout(() => api<typeof cands>(withBranch(`/api/finance/transactions/${id}/matches?q=${encodeURIComponent(matchQ)}`, branch)).then(setCands).catch(() => setCands(null)), 250);
    return () => clearTimeout(h);
  }, [matchQ, id, branch]);

  const amount = toMinor(t.amount);
  const isVoid = t.status === "VOID";
  const dir = amount > 0 ? "IN" : "OUT";
  const classOptions = ALL_CLASSES.filter((c) => c === "UNCLASSIFIED" || c === "INTERNAL_TRANSFER" || classDirection(c) === dir);
  const splitSum = splits.reduce((s, x) => s + (parseMoney(x.amount) ?? 0), 0);
  const splitsOk = cls === "INTERNAL_TRANSFER" || (splits.length > 0 && splitSum === amount && splits.every((s) => s.finCategoryId));
  const person = (pid: string | null) => d.data!.people.find((p) => p.id === pid)?.name ?? "—";
  const settlement = SETTLEMENT_CLASSES.includes(cls);
  const locked = !canEnter || isVoid;

  async function save(markReviewed: boolean, reverseAllocations = false) {
    setBusy(true); setErr(null);
    try {
      const body: Record<string, unknown> = { classification: cls, markReviewed, note: note || undefined, reverseAllocations };
      if (cls !== "INTERNAL_TRANSFER") body.splits = splits.filter((s) => s.finCategoryId).map((s) => ({ finCategoryId: s.finCategoryId, amount: s.amount }));
      if (settlement && (gross || fee)) { body.grossAmount = gross; body.feeAmount = fee; }
      const r = await api<{ autoRun?: { error?: string } | null }>(withBranch(`/api/finance/transactions/${id}/review`, branch), { method: "POST", json: body });
      if (r.autoRun && "error" in r.autoRun && r.autoRun.error) setErr(r.autoRun.error);
      d.reload(); onChanged();
    } catch (e) {
      const m = (e as Error).message;
      if (/already been allocated/.test(m)) setConfirmReverse(true);
      setErr(m);
    } finally { setBusy(false); }
  }
  async function act(path: string, json: unknown = {}) {
    setBusy(true); setErr(null);
    try { await api(withBranch(path, branch), { method: "POST", json }); d.reload(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function upload(file: File) {
    setBusy(true); setErr(null);
    const fd = new FormData(); fd.append("file", file);
    try { const r = await fetch(withBranch(`/api/finance/transactions/${id}/attachments`, branch), { method: "POST", body: fd }); if (!r.ok) throw new Error((await r.json()).error); d.reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  const [rar, ren, rtone] = reviewTone(t);
  return (
    <Card>
      <CardTitle title={L("مراجعة سطر بنكي", "Review bank line")} sub={`${d.data.transaction.cashAccount.code} · ${t.txnDate.slice(0, 10)}${t.bankReference ? ` · ${L("المرجع", "Ref")} ${t.bankReference}` : ""}`}
        right={<button type="button" onClick={onClose} aria-label={L("إغلاق", "Close")} className="text-brown-light hover:text-charcoal"><X size={16} /></button>} />
      <div className={`rounded-xl px-3.5 py-3 ${amount > 0 ? "bg-green-100" : "bg-cream-dark"}`}>
        <div className="flex items-center gap-2"><p className={`text-xs font-bold ${amount > 0 ? "text-green-700" : "text-brown"}`}>{amount > 0 ? L("وارد", "Money in") : L("صادر", "Money out")} · {L(t.status === "CONFIRMED" ? "مؤكد" : t.status === "PENDING" ? "معلّق" : "ملغى", t.status === "CONFIRMED" ? "confirmed" : t.status === "PENDING" ? "pending" : "void")}</p><Badge tone={rtone}>{L(rar, ren)}</Badge></div>
        <p className={`text-2xl font-extrabold tabular-nums ${amount > 0 ? "text-green-700" : "text-charcoal"}`}>{sar(amount)}</p>
        {t.grossAmount && <p className="text-xs text-brown">{L("الإجمالي", "Gross")} {money(toMinor(t.grossAmount))} − {L("الرسوم", "fees")} {money(toMinor(t.feeAmount ?? 0))} = {L("صافي الإيداع", "net deposit")} {money(amount)}</p>}
        <p className="text-xs text-charcoal mt-1">{t.description}</p>
      </div>

      {d.data.possibleDuplicate && t.status !== "VOID" && (
        <Notice tone="warn">
          <p>{L("تكرار محتمل لسطر آخر", "Possible duplicate of another line")}: {d.data.possibleDuplicate.txnDate.slice(0, 10)} · {money(toMinor(d.data.possibleDuplicate.amount))} · {d.data.possibleDuplicate.description ?? ""}.</p>
          <p className="text-xs mt-1">{L("إن كان سطراً مستقلاً فراجِعه كالمعتاد. وإن كان هو نفس المبلغ المسجَّل مسبقاً (مثل دفعة سُجّلت يدوياً ثم وصلت في الكشف) فادمجه: يُلغى سطر الكشف ويُؤكَّد السطر المسجّل، دون حركة نقدية ثانية.", "If it is a separate line, review it as usual. If it is the same money already recorded (e.g. a payment entered by hand that now appears on the statement), merge it: the statement line is voided and the recorded line confirmed, with no second cash movement.")}</p>
          {canEnter && t.source === "CSV_IMPORT" && <Button kind="secondary" busy={busy} className="mt-2" onClick={() => act(`/api/finance/transactions/${id}/resolve-duplicate`, { keepId: d.data!.possibleDuplicate!.id })}>{L("نفس المبلغ المسجّل — دمج", "Same money as the recorded line — merge")}</Button>}
        </Notice>
      )}
      {t.statementConfirmedAt && <Notice tone="ok" icon={CheckCircle2}>{L(`أكّده كشف البنك في ${t.statementConfirmedAt.slice(0, 10)} (دون إنشاء سطر جديد).`, `Confirmed by the bank statement on ${t.statementConfirmedAt.slice(0, 10)} (no new line created).`)}</Notice>}
      {t.classification === "UNCLASSIFIED" && amount > 0 && !isVoid && (
        <Notice tone="warn">{L("مصدر الإيداع غير معروف: لا يُعامل كتحصيل مبيعات ولا يُخصص قبل تصنيفه ومراجعته.", "Unknown source: not treated as a sales receipt and not allocated until it is classified and reviewed.")}</Notice>
      )}
      {t.reconciliationId && <Notice tone="info">{L("السطر ضمن تسوية مكتملة؛ لا يمكن إلغاؤه.", "This line is in a completed reconciliation; it cannot be voided.")}</Notice>}

      <Field label={L("التصنيف", "Classification")}>
        <select className={INPUT} disabled={locked} value={cls} onChange={(e) => setCls(e.target.value as TxnClass)}>
          {classOptions.map((c) => <option key={c} value={c}>{L(CLASS_LABELS[c].ar, CLASS_LABELS[c].en)}</option>)}
        </select>
      </Field>

      {settlement && (
        <div className="grid grid-cols-2 gap-2">
          <Field label={L("إجمالي المبيعات", "Gross proceeds")}><input className={INPUT} disabled={locked} value={gross} onChange={(e) => setGross(e.target.value)} inputMode="decimal" /></Field>
          <Field label={L("رسوم البوابة/الشبكة", "Gateway / network fee")}><input className={INPUT} disabled={locked} value={fee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" /></Field>
        </div>
      )}

      {cls !== "INTERNAL_TRANSFER" && (
        <div className="flex flex-col gap-2">
          <span className="text-xs font-bold text-brown">{L("التوزيع على بنود الميزانية", "Budget classification")}</span>
          {splits.map((s, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select aria-label={L("بند الميزانية", "Budget category")} className={INPUT} disabled={locked} value={s.finCategoryId} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, finCategoryId: e.target.value } : x)))}>
                <option value="">{L("اختر بنداً…", "Choose a category…")}</option>
                {finCats.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{name(c)}</option>)}
              </select>
              <input aria-label={L("المبلغ", "Amount")} className={`${INPUT} !w-[110px] font-bold tabular-nums`} disabled={locked} value={s.amount} onChange={(e) => setSplits(splits.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} inputMode="decimal" />
              {splits.length > 1 && !locked && <button type="button" onClick={() => setSplits(splits.filter((_, j) => j !== i))} className="text-brown-light hover:text-red-600" aria-label={L("حذف", "Remove")}><Trash2 size={14} /></button>}
            </div>
          ))}
          <div className="flex justify-between text-xs">
            {!locked ? <button type="button" className="font-bold text-orange" onClick={() => setSplits([...splits, { finCategoryId: "", amount: "0.00" }])}>{L("+ إضافة بند", "+ Add split")}</button> : <span />}
            <span className={`font-bold tabular-nums ${splitSum === amount ? "text-green-600" : "text-red-600"}`}>{L("المجموع", "Total")} {money(splitSum)} {L("من", "of")} {money(amount)} {splitSum === amount ? "✓" : ""}</span>
          </div>
          {settlement && <p className="text-[11px] text-brown-light">{L("للتسويات: البند الأول بالإجمالي، وبند الرسوم بالسالب، ليساوي المجموع صافي الإيداع دون ازدواج.", "For settlements: gross on the sales category and the fee as a negative split, so the total equals the net deposit without double counting.")}</p>}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="text-xs font-bold text-brown">{L("الربط بمستند", "Link to a document")}</span>
        {t.matches.filter((m) => m.active).map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-2 rounded-lg bg-cream-dark px-3 py-2 text-xs">
            <span><Link2 size={12} className="inline me-1" />{m.targetType} · {money(toMinor(m.amount))}{toMinor(m.taxAmount) > 0 ? ` · ${L("ضريبة", "VAT")} ${money(toMinor(m.taxAmount))}` : ""}</span>
            {canEnter && <button type="button" className="text-red-600 font-bold" onClick={() => { const r = prompt(L("سبب إلغاء الربط", "Reason for unlinking")); if (r) act(`/api/finance/matches/${m.id}/remove`, { reason: r }); }}>{L("إلغاء الربط", "Unlink")}</button>}
          </div>
        ))}
        {canEnter && !isVoid && (
          <>
            <input className={INPUT} placeholder={amount > 0 ? L("رقم الطلب أو اسم العميل", "Order number or customer") : L("وصف الالتزام أو الطرف", "Obligation or counterparty")} value={matchQ} onChange={(e) => setMatchQ(e.target.value)} />
            {cands && cands.rows.length > 0 && !matchPick && (
              <ul className="max-h-40 overflow-y-auto rounded-lg border border-border divide-y divide-border-light">
                {cands.rows.map((c) => (
                  <li key={c.id}><button type="button" className="w-full text-start px-3 py-2 text-xs hover:bg-cream" onClick={() => { setMatchPick({ id: c.id, label: (L(c.labelAr ?? c.label, c.label)) }); setMatchAmt(money(Math.min(Math.abs(amount), c.amount ?? Math.abs(amount))).replace(/[⁦⁩,−]/g, "")); }}>
                    {L(c.labelAr ?? c.label, c.label)}{c.matched !== undefined ? ` · ${L("مطابق سابقاً", "already matched")} ${money(c.matched)}` : ""}{c.dueDate ? ` · ${c.dueDate}` : ""}
                  </button></li>
                ))}
              </ul>
            )}
            {matchPick && (
              <div className="rounded-lg border-2 border-orange p-2.5 flex flex-col gap-2">
                <p className="text-xs font-bold">{matchPick.label}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Field label={L("المبلغ المطبق", "Amount applied")}><input className={INPUT} value={matchAmt} onChange={(e) => setMatchAmt(e.target.value)} inputMode="decimal" /></Field>
                  {amount > 0 && <Field label={L("ضريبة القيمة المضافة من الفاتورة", "VAT from the invoice")}><input className={INPUT} value={matchTax} onChange={(e) => setMatchTax(e.target.value)} inputMode="decimal" placeholder="0.00" /></Field>}
                </div>
                <div className="flex gap-2">
                  <Button kind="primary" busy={busy} onClick={async () => { await act(`/api/finance/transactions/${id}/matches`, { targetType: cands?.kind, targetId: matchPick.id, amount: matchAmt, taxAmount: matchTax || "0" }); setMatchPick(null); setMatchTax(""); }}>{L("ربط", "Link")}</Button>
                  <Button kind="ghost" onClick={() => setMatchPick(null)}>{L("إلغاء", "Cancel")}</Button>
                </div>
              </div>
            )}
            {cands?.note && <p className="text-[11px] text-brown-light">{L("طلبات البيع لا تحمل قيمة فاتورة بعد، لذا يُعرض ما سبق مطابقته فقط.", cands.note)}</p>}
            <p className="text-[11px] text-brown">{L("الربط لا يُنشئ إيصالاً جديداً. أدخل ضريبة القيمة المضافة من الفاتورة ليُحتجز في احتياطي الضريبة.", "Linking never creates a new receipt. Enter the invoice VAT so it is held in the tax reserve.")}</p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        {d.data.attachments.map((a) => (
          <a key={a.id} href={withBranch(`/api/finance/attachments/${a.id}`, branch)} className="flex items-center gap-2 text-xs text-orange font-bold"><Paperclip size={12} />{a.fileName}</a>
        ))}
        {canEnter && !isVoid && (
          <label className="flex items-center gap-2 px-3 py-2.5 rounded-[10px] border border-border text-xs text-brown cursor-pointer hover:bg-cream">
            <Paperclip size={16} />{L("إرفاق مستند (PDF أو صورة، حتى 5 ميغابايت)", "Attach a document (PDF or image, up to 5 MB)")}
            <input type="file" className="hidden" accept="application/pdf,image/png,image/jpeg,image/webp,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </label>
        )}
      </div>

      {amount > 0 && t.status === "CONFIRMED" && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-bold text-brown">{L("التخصيص من هذا الإيصال", "Allocated from this receipt")}</span>
          {d.data.entries.length === 0 ? <p className="text-xs text-brown-light">{L("لم يُخصص بعد.", "Not allocated yet.")}</p> : d.data.entries.map((e) => (
            <div key={e.id} className="flex justify-between text-xs"><span>{name(e.category)} · {e.entryType === "ALLOCATION" ? L("تخصيص", "allocation") : L("عكس", "reversal")}</span><span className="tabular-nums font-bold">{money(toMinor(e.amount) * (e.entryType === "ALLOCATION" ? 1 : -1))}</span></div>
          ))}
          <p className="text-xs text-brown">{L("غير مخصص من الإيصال", "Unallocated from receipt")}: <b className="tabular-nums">{money(d.data.unallocated)}</b></p>
          {canAllocate && t.reviewStatus === "REVIEWED" && isAllocatableClass(t.classification) && !d.data.run && d.data.unallocated > 0 && (
            <Button kind="primary" busy={busy} onClick={() => act("/api/finance/allocations/run", { txnId: id })}>{L("تخصيص حسب القواعد المعتمدة", "Allocate by approved rules")}</Button>
          )}
        </div>
      )}

      {canEnter && !isVoid && (
        <Field label={L("ملاحظة المراجعة", "Review note")}><input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      )}
      {err && <Notice tone="bad">{err}</Notice>}
      {confirmReverse && (
        <Notice tone="bad">
          <p>{L("سيُعكس ما خُصص من هذا الإيصال بقيود تسوية مسجّلة. إن كان المال قد صُرف فسيظهر عجز في الفئة ولن يُخفى.", "What this receipt funded will be reversed with recorded adjustments. If the money was already spent the category shows a shortfall; it is not hidden.")}</p>
          <Button kind="danger" busy={busy} onClick={() => save(true, true)}>{L("تأكيد العكس وإعادة التصنيف", "Confirm reversal and reclassify")}</Button>
        </Notice>
      )}
      {canEnter && !isVoid && (
        <div className="flex gap-2 flex-wrap">
          <Button kind="primary" icon={CheckCircle2} busy={busy} disabled={cls === "UNCLASSIFIED" || !splitsOk} onClick={() => save(true)}>{L("حفظ ووضع علامة مُراجعة", "Save and mark reviewed")}</Button>
          <Button busy={busy} onClick={() => save(false)}>{L("حفظ دون مراجعة", "Save without review")}</Button>
          {t.status === "PENDING" && <Button busy={busy} onClick={() => act(`/api/finance/transactions/${id}/confirm`)}>{L("تأكيد السطر", "Confirm line")}</Button>}
        </div>
      )}
      {canEnter && !isVoid && !t.reconciliationId && (
        <button type="button" className="text-xs font-bold text-red-600 self-start" onClick={() => { const r = prompt(L("سبب إلغاء السطر", "Reason for voiding")); if (r) act(`/api/finance/transactions/${id}/void`, { reason: r }); }}>{L("إلغاء السطر", "Void line")}</button>
      )}
      <div className="border-t border-border-light pt-2 flex flex-col gap-1">
        <span className="text-[11px] font-bold text-brown">{L("السجل", "History")}</span>
        {d.data.audits.slice(0, 5).map((a) => <p key={a.id} className="text-[11px] text-brown-light">{a.createdAt.slice(0, 16).replace("T", " ")} · {a.action} · {person(a.userId)}{a.reason ? ` · ${a.reason}` : ""}</p>)}
      </div>
    </Card>
  );
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

function ReconciliationCard({ accounts, canRecon, onDone }: { accounts: Account[]; canRecon: boolean; onDone: () => void }) {
  const { L, name, money } = useL();
  const { branch } = useFinance();
  const [accPick, setAcc] = useState(""); const [date, setDate] = useState(riyadhDateString); const [bal, setBal] = useState("");
  const acc = accPick || ((accounts.find((a) => !a.isRestricted && a.type === "BANK" && a.branchKey === "COMPANY") ?? accounts.find((a) => !a.isRestricted && a.type === "BANK"))?.id ?? accounts.find((a) => !a.isRestricted)?.id ?? accounts[0]?.id ?? "");
  const [prev, setPrev] = useState<{ ledgerBalance: number; pendingTotal: number; difference: number; unreconciled: unknown[] } | null>(null);
  const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const ready = !!acc && !!date && parseMoney(bal) !== null;
  useEffect(() => {
    const h = setTimeout(() => {
      if (!ready) { setPrev(null); return; }
      api<typeof prev>(withBranch("/api/finance/reconciliations/preview", branch), { method: "POST", json: { cashAccountId: acc, statementDate: date, statementBalance: bal } }).then((p) => { setPrev(p); setErr(null); setMsg(null); }).catch((e) => setErr(e.message));
    }, 300);
    return () => clearTimeout(h);
  }, [acc, date, bal, branch, ready]);
  async function save() {
    setBusy(true); setErr(null);
    try { const r = await api<{ status: string }>(withBranch("/api/finance/reconciliations", branch), { method: "POST", json: { cashAccountId: acc, statementDate: date, statementBalance: bal } }); setMsg(r.status === "COMPLETED" ? L("اكتملت التسوية.", "Reconciliation completed.") : L("حُفظت كمسودة تُظهر الفرق.", "Saved as a draft showing the difference.")); onDone(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Card>
      <CardTitle title={L("التسوية مع كشف البنك", "Reconcile with the bank statement")} sub={L("رصيد الدفتر = الرصيد الافتتاحي + السطور المؤكدة حتى التاريخ. السطور المعلّقة تُعرض ولا تُحتسب.", "Book balance = opening balance + confirmed lines to the date. Pending lines are shown, not counted.")} />
      <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_1fr_auto] gap-3 items-end">
        <Field label={L("الحساب", "Account")}><select className={INPUT} value={acc} onChange={(e) => setAcc(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}</select></Field>
        <Field label={L("تاريخ الكشف", "Statement date")}><input type="date" className={INPUT} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={L("رصيد الكشف", "Statement balance")}><input className={`${INPUT} font-bold`} value={bal} onChange={(e) => setBal(e.target.value)} inputMode="decimal" placeholder="0.00" /></Field>
        {canRecon && <Button kind="primary" icon={Scale} busy={busy} disabled={!prev} onClick={save}>{L("حفظ التسوية", "Save reconciliation")}</Button>}
      </div>
      {prev && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="rounded-xl bg-cream-dark px-3.5 py-3"><p className="text-xs font-bold text-brown">{L("رصيد الدفتر", "Book balance")}</p><p className="text-lg font-extrabold tabular-nums">{money(prev.ledgerBalance)}</p></div>
          <div className="rounded-xl bg-cream-dark px-3.5 py-3"><p className="text-xs font-bold text-brown">{L("المعلّق حتى التاريخ (غير محتسب)", "Pending to date (not counted)")}</p><p className="text-lg font-extrabold tabular-nums">{money(prev.pendingTotal)}</p></div>
          <div className={`rounded-xl px-3.5 py-3 ${prev.difference === 0 ? "bg-green-100" : "bg-red-100"}`}><p className="text-xs font-bold text-brown">{L("الفرق", "Difference")}</p><p className={`text-lg font-extrabold tabular-nums ${prev.difference === 0 ? "text-green-700" : "text-red-600"}`}>{money(prev.difference)}</p></div>
        </div>
      )}
      {prev && prev.difference !== 0 && <p className="text-xs text-brown">{L("لا يمكن إكمال التسوية بفرق. تُحفظ كمسودة تُظهر الفرق حتى يُعالج.", "A reconciliation cannot be completed with a difference. It is saved as a draft that shows the gap until it is resolved.")}{prev.difference === prev.pendingTotal ? L(" (هنا يطابق الفرق السطور المعلّقة.)", " (Here the difference equals the pending lines.)") : ""}</p>}
      {err && <Notice tone="bad">{err}</Notice>}
      {msg && <Notice tone="ok" icon={CheckCircle2}>{msg}</Notice>}
    </Card>
  );
}

// ─── Manual entry & transfer ─────────────────────────────────────────────────

function ManualDialog({ open, onClose, accounts, onDone }: { open: boolean; onClose: () => void; accounts: Account[]; onDone: () => void }) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const idem = useIdempotencyKey();
  const [today] = useState(riyadhDateString);
  const [form, setF] = useState({ cashAccountId: "", txnDate: today, amount: "", status: "CONFIRMED", bankReference: "", description: "", counterparty: "" });
  const f = { ...form, cashAccountId: form.cashAccountId || accounts[0]?.id || "" };
  const [err, setErr] = useState<Record<string, string>>({}); const [busy, setBusy] = useState(false); const [serverErr, setServerErr] = useState<string | null>(null);
  function validate() {
    const e: Record<string, string> = {};
    const a = parseMoney(f.amount);
    if (a === null || a === 0) e.amount = L("أدخل مبلغاً صالحاً بخانتين عشريتين كحد أقصى.", "Enter a valid amount with at most two decimals.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.txnDate)) e.txnDate = L("أدخل التاريخ.", "Enter the date.");
    else if (f.status === "CONFIRMED" && f.txnDate > today) e.txnDate = L("لا يمكن تأكيد سطر بتاريخ مستقبلي؛ سجّله كمعلّق.", "A future-dated line cannot be confirmed; record it as pending.");
    setErr(e); return Object.keys(e).length === 0;
  }
  async function submit() {
    if (!validate()) return;
    setBusy(true); setServerErr(null);
    try { await api(withBranch("/api/finance/transactions", branch), { method: "POST", json: { ...f, idempotencyKey: idem.key } }); idem.renew(); onDone(); onClose(); setF((x) => ({ ...x, amount: "", bankReference: "", description: "", counterparty: "" })); }
    catch (e) { setServerErr((e as Error).message); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ref = f.bankReference.trim();
  const sameRef = useApi<{ total: number }>(ref.length >= 3 && f.cashAccountId ? withBranch(`/api/finance/transactions?take=1&accountId=${encodeURIComponent(f.cashAccountId)}&reference=${encodeURIComponent(ref)}`, branch) : null);
  return (
    <Dialog open={open} onClose={onClose} title={L("قيد يدوي", "Manual entry")} sub={L("سطر بنكي أو نقدي فعلي. للمبالغ الصادرة استخدم إشارة سالبة.", "An actual bank or cash line. Use a negative amount for money out.")}>
      <Field label={L("الحساب", "Account")}><select className={INPUT} value={f.cashAccountId} onChange={set("cashAccountId")}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>)}</select></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("المبلغ (سالب للمبالغ الصادرة)", "Amount (negative for money out)")} error={err.amount}><input className={`${INPUT} ${err.amount ? "!border-red-600" : ""}`} value={f.amount} onChange={set("amount")} inputMode="decimal" /></Field>
        <Field label={L("التاريخ", "Date")} error={err.txnDate}><input type="date" className={`${INPUT} ${err.txnDate ? "!border-red-600" : ""}`} value={f.txnDate} onChange={set("txnDate")} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("الحالة", "Status")}><select className={INPUT} value={f.status} onChange={set("status")}><option value="CONFIRMED">{L("مؤكد", "Confirmed")}</option><option value="PENDING">{L("معلّق", "Pending")}</option></select></Field>
        <Field label={L("المرجع البنكي", "Bank reference")}><input className={INPUT} value={f.bankReference} onChange={set("bankReference")} /></Field>
      </div>
      {sameRef.data && sameRef.data.total > 0 && (
        <Notice tone="warn">
          <p className="font-bold">{L("يوجد سطر بالمرجع نفسه في هذا الحساب", "A line with the same reference exists on this account")}</p>
          <p className="text-xs">{L("سيُحفظ ويُعلَّم للمراجعة كتكرار محتمل — لا يُرفض تلقائياً.", "It will be saved and flagged for review as a possible duplicate — not rejected automatically.")}</p>
        </Notice>
      )}
      <Field label={L("الوصف", "Description")}><input className={INPUT} value={f.description} onChange={set("description")} /></Field>
      <Field label={L("الطرف", "Counterparty")}><input className={INPUT} value={f.counterparty} onChange={set("counterparty")} /></Field>
      {serverErr && <Notice tone="bad">{serverErr}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("حفظ", "Save")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}

function TransferDialog({ open, onClose, accounts, onDone }: { open: boolean; onClose: () => void; accounts: Account[]; onDone: () => void }) {
  const { L, name } = useL();
  const { branch } = useFinance();
  const [f, setF] = useState(() => ({ fromAccountId: "", toAccountId: "", amount: "", txnDate: riyadhDateString(), description: "" }));
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const opts = useMemo(() => accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {name(a)}</option>), [accounts, name]);
  async function submit() {
    setBusy(true); setErr(null);
    try { await api(withBranch("/api/finance/transfers", branch), { method: "POST", json: f }); onDone(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onClose={onClose} title={L("تحويل بين حسابات الشركة", "Transfer between company accounts")} sub={L("ليس إيراداً ولا مصروفاً، ولا يغيّر النقد الموحد.", "Neither revenue nor expense; consolidated cash does not change.")}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={L("من", "From")}><select className={INPUT} value={f.fromAccountId} onChange={set("fromAccountId")}><option value="">—</option>{opts}</select></Field>
        <Field label={L("إلى", "To")}><select className={INPUT} value={f.toAccountId} onChange={set("toAccountId")}><option value="">—</option>{opts}</select></Field>
        <Field label={L("المبلغ", "Amount")}><input className={INPUT} value={f.amount} onChange={set("amount")} inputMode="decimal" /></Field>
        <Field label={L("التاريخ", "Date")}><input type="date" className={INPUT} value={f.txnDate} onChange={set("txnDate")} /></Field>
      </div>
      <Field label={L("الوصف", "Description")}><input className={INPUT} value={f.description} onChange={set("description")} /></Field>
      {err && <Notice tone="bad">{err}</Notice>}
      <div className="flex gap-2"><Button kind="primary" busy={busy} onClick={submit}>{L("تسجيل التحويل", "Record transfer")}</Button><Button onClick={onClose}>{L("إلغاء", "Cancel")}</Button></div>
    </Dialog>
  );
}
