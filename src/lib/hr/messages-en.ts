// Native HR — English reading of the Arabic text the HR server writes itself (not the user's).
//
// Some HR text is composed in Arabic by the server: payroll line descriptions and exceptions
// (stored with the run when it is built — immutable once approved), profile reminders and
// offboarding clearance details (computed per request). In English the screens show this
// reading instead; the stored text is never changed. A text without a rule is shown as stored
// — names, titles and anything a person typed are data and stay as entered.
//
// Numbers, codes and dates are carried over unchanged. Pure and client-safe.
type Rule = [RegExp, (m: RegExpMatchArray) => string];

const COMPONENT: Record<string, string> = { "الراتب الأساسي": "Basic salary", "بدل السكن": "Housing allowance", "بدل النقل": "Transport allowance", "بدلات أخرى": "Other allowances" };
const DED_CAT: Record<string, string> = { "الأجر غير المستحق": "Unearned pay", "استرداد السلف": "Advance recovery", "الاشتراكات النظامية": "Statutory contributions", "الاستقطاعات الأخرى": "Other deductions" };
const plural = (n: string, one: string, many: string) => (Number(n) === 1 ? `${n} ${one}` : `${n} ${many}`);

const RULES: Rule[] = [
  // ── Payroll items (payroll-engine.ts)
  [/^(الراتب الأساسي|بدل السكن|بدل النقل|بدلات أخرى) \((.+)\)$/, (m) => `${COMPONENT[m[1]]} (${m[2]})`],
  [/^(الراتب الأساسي|بدل السكن|بدل النقل|بدلات أخرى)$/, (m) => COMPONENT[m[1]]],
  [/^عمل إضافي معتمد ([\d.]+) ساعة × ([\d.]+)$/, (m) => `Approved overtime ${m[1]} h × ${m[2]}`],
  [/^عمولة معتمدة · (\d{4}-\d{2})$/, (m) => `Approved commission · ${m[1]}`],
  [/^إجازة بدون راتب (\d+) يوم$/, (m) => `Unpaid leave · ${plural(m[1], "day", "days")}`],
  [/^(.+) · حصة الموظف$/, (m) => `${m[1]} · employee share`],
  [/^(.+) · حصة صاحب العمل$/, (m) => `${m[1]} · employer share`],
  [/^قسط سلفة (\S+) \((\d+)\)$/, (m) => `Advance instalment ${m[1]} (${m[2]})`],
  // ── Payroll exceptions (payroll-engine.ts)
  [/^لا يوجد راتب مسجّل لـ (\d+) يوم عمل في هذا الشهر\.$/, (m) => `No salary is recorded for ${plural(m[1], "working day", "working days")} this month.`],
  [/^على رأس العمل من (\S+) إلى (\S+): (\S+) من (\d+) يوم مستحق \((30 يومًا ثابتة|أيام الشهر الفعلية)\)\.$/, (m) => `Employed ${m[1]} to ${m[2]}: ${m[3]} of ${m[4]} days payable (${m[5] === "30 يومًا ثابتة" ? "fixed 30 days" : "actual days in the month"}).`],
  // P-2 rev3 item 6: calendar days and pay units apart.
  [/^على رأس العمل من (\S+) إلى (\S+) \((\d+) يومًا تقويميًا\): (\S+) من (\d+) وحدة أجر \((30 يومًا ثابتة|أيام الشهر الفعلية)\)\.$/, (m) => `Employed ${m[1]} to ${m[2]} (${m[3]} calendar days): ${m[4]} of ${m[5]} pay units (${m[6] === "30 يومًا ثابتة" ? "fixed 30 days" : "actual days in the month"}).`],
  [/^خُصم (\d+) يوم إجازة بدون راتب\.$/, (m) => `${plural(m[1], "day", "days")} of unpaid leave deducted.`],
  [/^توجد قواعد اشتراكات سارية لكن فئة اشتراك الموظف غير مسجّلة\.$/, () => "Active contribution rules exist, but the employee’s contribution group is not recorded."],
  [/^أُجّل (\d+) قسط سلفة: الاستقطاعات ستتجاوز ([\d.]+)% من الإجمالي\.$/, (m) => `${plural(m[1], "advance instalment", "advance instalments")} deferred: deductions would exceed ${m[2]}% of gross.`],
  [/^سيكون الصافي (-?[\d.]+)\. عالج الاستقطاعات قبل الإرسال للاعتماد\.$/, (m) => `Net would be ${m[1]}. Resolve the deductions before submitting for approval.`],
  [/^(\d+) يوم غياب مسجّل\. لا يُخصم تلقائيًا: سجّل إجازة بدون راتب أو تسوية إن كان الخصم مقصودًا\.$/, (m) => `${plural(m[1], "recorded absence", "recorded absences")}. Not deducted automatically: record unpaid leave or an adjustment if a deduction is intended.`],
  [/^(\d+) يوم حضور بلا تسجيل انصراف\.$/, (m) => `${plural(m[1], "day", "days")} with check-in but no check-out.`],
  [/^قيم سياسة الرواتب v(\d+) مقترحة ولم يؤكدها المالك أو المحاسب بعد\.$/, (m) => `Payroll policy v${m[1]} values are proposed and not yet confirmed by the owner or the accountant.`],
  // P-2 line controls (src/lib/hr/payroll-controls.ts)
  [/^إجازات بدون راتب معتمدة متداخلة في (\d+) يوم \((\S+)(?: … (\S+))?\)\. لا يُخصم اليوم مرتين: صحّح الإجازات ثم أعد البناء\.$/, (m) => `Approved unpaid leaves overlap on ${plural(m[1], "day", "days")} (${m[2]}${m[3] ? ` … ${m[3]}` : ""}). A day is never deducted twice: correct the leaves, then rebuild.`],
  [/^نوع الإجازة (.+) ما زال مقترحًا ويؤثر في الراتب\. يؤكده مسؤول سياسات ثانٍ قبل احتساب المسيّر\.$/, (m) => `Leave type ${m[1]} is still a proposal and affects pay. A second policy manager confirms it before the run is calculated.`],
  [/^الفترة المستحقة كلها \((\S+) → (\S+)\) إجازة بدون راتب معتمدة، ومع ذلك يتبقى ([\d.]+) من مكونات الخصم\..*$/, (m) => `The whole payable period (${m[1]} → ${m[2]}) is approved unpaid leave, yet ${m[3]} of the deductible components remains. Not paid, and no attestation or deduction lifts the block: correct the leave or attendance data, then rebuild (the calculation rule is the accountant's decision D-2a).`],
  // P-2 review P1-B2: earnings for a separating person (services/payroll-controls.ts)
  [/^(\d+) تسوية بصياغة تشبه مكافأة نهاية الخدمة أو بدل الإجازة\..*$/, (m) => `${plural(m[1], "adjustment is", "adjustments are")} worded like end of service or leave encashment. Those are paid by the final settlement, not by payroll: check the category before approving.`],
  [/^مجموع التسويات الإضافية منذ إنهاء الخدمة ([\d.]+) يبلغ مبلغ تسوية نهائية مسجّلًا \((.+)\)\. يُصرف من التسوية النهائية فقط ولا يُقبل بإقرار\.$/, (m) => `Earning adjustments since the separation total ${m[1]}, reaching a final-settlement amount on record (${m[2].replace(/،/g, ",")}). It is paid by the final settlement only and cannot be attested.`],
  [/^تسوية إضافية لموظف منتهية خدمته \(مجموعها منذ الإنهاء ([\d.]+)\) أقرّها شخص مستقل \((\S+)\)\.$/, (m) => `Earning adjustment for a separating employee (total since the separation ${m[1]}) attested by an independent person (${m[2]}).`],
  [/^سجل الموظف بلا رقم هوية، فلا يمكن ربطه بسجل آخر للشخص نفسه.*$/, () => "This employee record has no identity number, so it cannot be matched to another record of the same person: the end-of-service and final-settlement check is incomplete for this line. Complete the identity number before payroll is activated."],
  [/^تسوية إضافية لموظف بدأ إنهاء خدمته أو اكتمل \(مجموعها منذ الإنهاء ([\d.]+)\)\..*$/, (m) => `Earning adjustment for an employee whose separation is initiated or completed (total since the separation ${m[1]}). Not approved until an independent person — neither a preparer nor an approver of the run, nor the payee — attests it.`],
  // ── P-2 deduction categories (payroll-engine.ts)
  [/^(الأجر غير المستحق|استرداد السلف|الاشتراكات النظامية|الاستقطاعات الأخرى) ([\d.]+) تتجاوز حدها ([\d.]+) \(([\d.]+)% من ([\d.]+)\)\.$/, (m) => `${DED_CAT[m[1]]} ${m[2]} exceed their cap of ${m[3]} (${m[4]}% of ${m[5]}).`],
  [/^الاستقطاعات المشمولة بالحد العام ([\d.]+) تتجاوز ([\d.]+) \(([\d.]+)% من ([\d.]+)\)\.$/, (m) => `Deductions covered by the overall cap, ${m[1]}, exceed ${m[2]} (${m[3]}% of ${m[4]}).`],
  [/^قسط السلفة (.+) يتجاوز حد الاستقطاع بمفرده، فلن يُستقطع حتى يُعاد جدولته أو يُحصَّل بإجراء معتمد\.$/, (m) => `Advance instalment ${m[1]} is above the deduction cap on its own, so it will not be deducted until it is rescheduled or collected by an approved procedure.`],
  // ── Reminders (people.ts)
  [/^ينتهي العقد (\S+)$/, (m) => `Contract ${m[1]} ends`],
  [/^آخر موعد لإشعار التجديد أو عدمه \((\d+) يومًا\)$/, (m) => `Last date for renewal notice (${m[1]} days)`],
  [/^نهاية فترة التجربة$/, () => "Probation ends"],
  [/^انتهاء الهوية \/ الإقامة$/, () => "ID / iqama expiry"],
  [/^انتهاء (.+)$/, (m) => `${m[1]} expires`],
  // ── Offboarding clearance (workforce.ts)
  [/^(\d+) طلب إجازة بانتظار القرار$/, (m) => `${plural(m[1], "leave request", "leave requests")} awaiting decision`],
  [/^المسير #(\d+) · (مصروف|معتمد)$/, (m) => `Run #${m[1]} · ${m[2] === "مصروف" ? "paid" : "approved"}`],
  [/^لا يوجد مسير معتمد يغطي آخر يوم عمل بعد$/, () => "No approved run covers the last working day yet"],
  // ── Permission-change requests: the reason the server records when none is given (api/employees/[id])
  [/^منح مهام رواتب حساسة$/, () => "Grant of sensitive payroll duties"],
  [/^تغيير بيانات دخول حساب يحمل مهام حساسة$/, () => "Sign-in change on an account with sensitive duties"],
];

/** The English reading of a server-composed Arabic HR text, or the text unchanged. */
export function hrTextEn(text: string): string {
  const s = text.trim();
  for (const [re, fn] of RULES) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return text;
}

// The few texts the server composes in English (leave ledger reasons), read in Arabic.
const AR_RULES: Rule[] = [
  [/^Approved leave$/, () => "إجازة معتمدة"],
  [/^Monthly accrual (\d{4}-\d{2})$/, (m) => `استحقاق شهري ${m[1]}`],
  [/^Cancelled: ([\s\S]+)$/, (m) => `أُلغيت: ${m[1]}`],
];

/** The Arabic reading of a server-composed English HR text, or the text unchanged. */
export function hrTextAr(text: string): string {
  const s = text.trim();
  for (const [re, fn] of AR_RULES) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return text;
}

/** `text` in the viewer's language: each side's server-composed text is read in that language. */
export const hrText = (text: string, lang: "ar" | "en") => (lang === "en" ? hrTextEn(text) : hrTextAr(text));
