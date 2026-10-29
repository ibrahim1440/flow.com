"use client";

// «الأصول عند بدء المحاسبة» — what the register holds that the ledger does not (assets existing at go-live, anything
// recorded while accounting was off) and the button that writes it into the opening-balance grid (the inventory
// valuation's pattern). Repeatable until the opening is posted.
import Link from "next/link";
import { useState } from "react";
import { OpsLoading, Btn } from "@/components/ops/ui";
import { Section } from "@/components/chrome";
import { Msg, money, useApi, useLang, useWrite } from "../../_ui/shell";
import { Money, type Can } from "./fa";

type P = { goLiveDate: string | null; active: boolean; openingPosted: boolean; goLiveFirstOfMonth: boolean; lines: { slot: string; accountId: string | null; account: { code: string; name: string | null } | null; debit: string; credit: string; events: number }[];
  unmapped: boolean; inGrid: boolean; otherGridLines: { count: number; debit: string; credit: string }; afterGoLive: string; can: Can };

export function Opening() {
  const { L } = useLang();
  const p = useApi<P>("/api/accounting/fixed-assets/opening");
  const w = useWrite();
  const d = p.data;
  // Batch 22 WP-G: manual grid lines on the same accounts are refused unless confirmed (no double counting).
  const [confirmOther, setConfirmOther] = useState(false);
  async function apply() { if (await w.run("apply", "/api/accounting/fixed-assets/opening", "POST", { confirmOtherLines: confirmOther }, L("كُتبت أسطر الأصول الثابتة في الأرصدة الافتتاحية.", "The fixed-asset lines are in the opening balances."))) p.reload(); }
  return (
    <Section title={L("الأصول الثابتة في الأرصدة الافتتاحية", "Fixed assets in the opening balances")} testId="faopen" actions={d ? <span className="acct-hint" style={{ color: "inherit" }}>{d.goLiveDate ? L(`تاريخ البدء ${d.goLiveDate}`, `Go-live ${d.goLiveDate}`) : L("لم يُحدَّد تاريخ البدء", "No go-live date")}</span> : undefined}>
      <Msg error={w.error ?? p.error} done={w.done} onClose={() => { w.setError(null); w.setDone(null); }} />
      {!d ? <OpsLoading /> : (
        <div className="fa-body">
          <p className="acct-hint">{L("الأصول القائمة عند بدء المحاسبة (افتتاحي) وما سُجّل قبل التفعيل يدخل الدفاتر عبر الأرصدة الافتتاحية: سطر مدين لكل حساب تكلفة وسطر دائن لكل حساب مجمع إهلاك. يُغلق الفرق على حقوق ملكية الأرصدة الافتتاحية مع بقية الأرصدة.", "Assets existing at go-live (opening) and what was recorded before activation enter the books through the opening balances: a debit line per cost account and a credit line per accumulated-depreciation account. The difference closes to opening balance equity with the rest.")}</p>
          {d.lines.length === 0 ? <p data-testid="faopen-empty">{L("لا شيء خارج الدفاتر: كل ما في السجل مرحّل.", "Nothing outside the books: everything in the register is posted.")}</p> : (
            <div className="hr-tablewrap"><table className="hr-table is-dense" data-testid="faopen-lines">
              <thead><tr><th>{L("الحساب", "Account")}</th><th className="num">{L("مدين", "Debit")}</th><th className="num">{L("دائن", "Credit")}</th><th className="num">{L("الحركات", "Events")}</th></tr></thead>
              <tbody>{d.lines.map((l, i) => <tr key={i}><td>{l.account ? <><span className="acct-code">{l.account.code}</span> {l.account.name}</> : <span className="acct-warn">{L("غير مربوط — اربط أدوار الأصول الثابتة", "Not mapped — map the fixed-asset roles")}</span>}</td><td className="num"><Money v={l.debit} /></td><td className="num"><Money v={l.credit} /></td><td className="num">{l.events}</td></tr>)}</tbody>
            </table></div>
          )}
          {Number(d.afterGoLive) ? <p className="acct-warn">{L(`سُجّل ${money(d.afterGoLive)} ر.س بتاريخ بعد بدء المحاسبة أثناء إيقافها؛ يدخل عبر الأرصدة الافتتاحية (الجانب المقابل في حقوق الملكية). الأفضل عكس قيد الإهلاك وإعادته بعد التفعيل.`, `SAR ${money(d.afterGoLive)} was recorded with dates after go-live while accounting was off; it enters through the opening (its other side in equity). Better: reverse that run and run it again after activation.`)}</p> : null}
          {d.otherGridLines.count ? <p className="acct-warn">{L(`في الأرصدة الافتتاحية ${d.otherGridLines.count} سطرًا آخر على حسابات الأصول أُدخل يدويًا (مدين ${money(d.otherGridLines.debit)} · دائن ${money(d.otherGridLines.credit)}): تأكد ألا يتكرر الأصل.`, `The opening grid has ${d.otherGridLines.count} other line(s) on the fixed-asset accounts entered by hand (debit ${money(d.otherGridLines.debit)} · credit ${money(d.otherGridLines.credit)}): make sure nothing counts twice.`)}<br />
            <label className="faimp-check"><input type="checkbox" checked={confirmOther} onChange={(e) => setConfirmOther(e.target.checked)} data-testid="faopen-confirm-other" /> {L("أؤكد أن هذه الأسطر ليست أصولًا من السجل", "I confirm these lines are not assets of the register")}</label></p> : null}
          <div className="acct-foot">
            <span>{!d.goLiveFirstOfMonth ? <span className="acct-bad" data-testid="faopen-golive">{L("تاريخ بدء المحاسبة ليس أول الشهر: سجل الأصول الثابتة يحتاجه أول يوم في الشهر (المحاسبة › الإعدادات).", "The go-live date is not the 1st of a month: the fixed-asset register needs it on the 1st (Accounting › Settings).")}</span> : d.openingPosted ? L("رُحّلت الأرصدة الافتتاحية: هذا الجزء نهائي.", "The opening is posted: this is final.") : d.inGrid ? <span className="acct-good">{L("الأرصدة الافتتاحية تحمل أسطر الأصول الحالية.", "The opening grid carries the current lines.")}</span> : <span className="acct-warn">{L("الأرصدة الافتتاحية لا تحمل الأسطر الحالية بعد.", "The opening grid does not carry the current lines yet.")}</span>}</span>
            <span className="acct-actions">
              <Link className="hr-btn" href="/dashboard/accounting/opening">{L("الأرصدة الافتتاحية", "Opening balances")}</Link>
              {d.can.opening && !d.openingPosted && d.goLiveFirstOfMonth && d.lines.length ? <Btn variant="primary" disabled={d.otherGridLines.count > 0 && !confirmOther} busy={w.busy === "apply"} onClick={apply} data-testid="faopen-apply">{L("كتابة الأسطر في الأرصدة الافتتاحية", "Write the lines into the opening")}</Btn> : null}
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}
