// Accounting core A1 — every refusal of the accounting core, in Arabic and English, with a stable code and an
// HTTP status. Services throw `refuse(code, …)`; routes answer `refusalJson(err)` (Arabic `error`, English
// `errorEn`, `code`). The database's own "LEDGER: …" refusals (triggers of 20261102090000_accounting_core) are
// mapped here too (ledgerDbRefusal), so a guard firing is a 409 with a code, never a 500. Pure.
import { AccountingError } from "./errors";

type R = { status: number; en: string; ar: string };

export const REFUSALS = {
  BAD_INPUT: { status: 400, en: "The request is not valid.", ar: "الطلب غير صالح." },
  NOT_FOUND: { status: 404, en: "Not found.", ar: "غير موجود." },
  NOT_ACTIVE: { status: 409, en: "Accounting is not activated.", ar: "المحاسبة غير مفعّلة بعد." },
  BEFORE_GO_LIVE: { status: 409, en: "The date is before the accounting go-live date.", ar: "التاريخ قبل تاريخ بدء المحاسبة." },
  LINES_MIN: { status: 400, en: "A journal entry needs at least two non-zero lines.", ar: "القيد يحتاج سطرين على الأقل بمبالغ غير صفرية." },
  LINE_SIDE: { status: 400, en: "Each line is either a debit or a credit, greater than zero.", ar: "كل سطر مدين أو دائن بمبلغ أكبر من صفر، لا كليهما." },
  AMOUNT: { status: 400, en: "An amount is not a valid decimal (2 decimal places, numeric(18,2)).", ar: "مبلغ غير صالح (رقم عشري بخانتين كحد أقصى)." },
  UNBALANCED: { status: 400, en: "Debits must equal credits.", ar: "مجموع المدين يجب أن يساوي مجموع الدائن." },
  ROUNDING_TOO_LARGE: { status: 400, en: "The rounding difference is larger than rounding can explain.", ar: "فرق التقريب أكبر مما يفسّره التقريب." },
  ROLE_UNKNOWN: { status: 400, en: "Unknown posting role.", ar: "دور ترحيل غير معروف." },
  ROLE_NOT_MAPPED: { status: 409, en: "A posting role is not mapped to an account.", ar: "دور ترحيل غير مربوط بحساب." },
  ROLE_TYPE: { status: 400, en: "The account's type does not suit this posting role.", ar: "نوع الحساب لا يناسب دور الترحيل هذا." },
  ACCOUNT_NOT_FOUND: { status: 400, en: "An account was not found.", ar: "حساب غير موجود." },
  ACCOUNT_NOT_POSTABLE: { status: 400, en: "Post only to an active, postable leaf account (not a header).", ar: "الترحيل إلى حساب فرعي نشط قابل للترحيل فقط (لا حساب رئيسي)." },
  CONTROL_ACCOUNT_MANUAL: { status: 409, en: "A control account (AR, AP, inventory, VAT …) is fed by its sub-ledger: a manual journal may not use it.", ar: "حساب المراقبة (الذمم، المخزون، الضريبة …) يُرحَّل من دفتره الفرعي؛ لا يقبل قيدًا يدويًا." },
  PARTY_REQUIRED: { status: 400, en: "A line on an AR / AP control account names its customer or supplier.", ar: "سطر حساب الذمم يحدد العميل أو المورد." },
  PARTY_TYPE: { status: 400, en: "AR lines name a customer; AP lines name a supplier.", ar: "سطر الذمم المدينة يحدد عميلًا، وسطر الذمم الدائنة يحدد موردًا." },
  DIMENSION_NOT_FOUND: { status: 400, en: "A dimension (branch, cost centre, party or item) was not found.", ar: "بُعد غير موجود (فرع أو مركز تكلفة أو طرف أو صنف)." },
  PERIOD_MISSING: { status: 409, en: "No fiscal period covers this date.", ar: "لا توجد فترة مالية تغطي هذا التاريخ." },
  PERIOD_SOFT_CLOSED: { status: 409, en: "The fiscal period is soft-closed: posting into it is refused.", ar: "الفترة المالية مقفلة مؤقتًا؛ الترحيل إليها مرفوض." },
  PERIOD_CLOSED: { status: 409, en: "The fiscal period is closed: posting into it is refused.", ar: "الفترة المالية مقفلة نهائيًا؛ الترحيل إليها مرفوض." },
  PERIOD_STATE: { status: 409, en: "The fiscal period is not in a state that allows this.", ar: "حالة الفترة المالية لا تسمح بهذا الإجراء." },
  PERIOD_PENDING: { status: 409, en: "The period still has journal entries pending (draft, submitted or approved).", ar: "في الفترة قيود معلّقة (مسودة أو مقدّمة أو معتمدة)." },
  REASON_REQUIRED: { status: 400, en: "A reason is required (at least 3 characters).", ar: "السبب مطلوب (3 أحرف على الأقل)." },
  YEAR_EXISTS: { status: 409, en: "This fiscal year exists already.", ar: "هذه السنة المالية موجودة مسبقًا." },
  IDEMPOTENCY_CONFLICT: { status: 409, en: "This source event was already posted with different lines.", ar: "هذا الحدث رُحّل مسبقًا بسطور مختلفة." },
  ALREADY_REVERSED: { status: 409, en: "This journal entry has already been reversed.", ar: "عُكس هذا القيد مسبقًا." },
  REVERSAL_BEFORE_ORIGINAL: { status: 409, en: "A reversal is dated on or after the entry it reverses.", ar: "تاريخ القيد العكسي لا يسبق تاريخ القيد الأصلي." },
  NOT_POSTED: { status: 409, en: "Only a posted journal entry can be reversed.", ar: "يُعكس القيد المرحَّل فقط." },
  HR_JOURNAL: { status: 409, en: "A journal posted by HR is reversed only through HR.", ar: "قيد الموارد البشرية لا يُعكس إلا من خلال الموارد البشرية." },
  OPENING_FINAL: { status: 409, en: "The opening entry is final: correct it with an adjusting journal.", ar: "قيد الأرصدة الافتتاحية نهائي؛ يُصحَّح بقيد تسوية." },
  NOT_ENGINE_ENTRY: { status: 409, en: "This entry was not posted by the posting engine.", ar: "هذا القيد لم يُرحَّل بمحرك الترحيل." },
  CHART_NOT_EMPTY: { status: 409, en: "The chart of accounts is not empty: the default chart is seeded only into an empty chart.", ar: "دليل الحسابات ليس فارغًا؛ يُهيّأ الدليل الافتراضي في دليل فارغ فقط." },
  CODE_EXISTS: { status: 409, en: "An account with this code exists already.", ar: "يوجد حساب بهذا الرمز." },
  ACCOUNT_IN_USE: { status: 409, en: "The account is in use (journal lines, a posting role, opening balances or sub-accounts).", ar: "الحساب مستخدم (سطور قيود أو دور ترحيل أو أرصدة افتتاحية أو حسابات فرعية)." },
  ACCOUNT_LOCKED: { status: 409, en: "An account with journal lines keeps its code, type and normal balance.", ar: "الحساب الذي عليه حركات يحتفظ برمزه ونوعه وطبيعة رصيده." },
  PARENT_INVALID: { status: 400, en: "The parent must be a header account of the same type, not the account itself or one of its sub-accounts.", ar: "الحساب الأب يجب أن يكون حسابًا رئيسيًا من النوع نفسه، لا الحساب نفسه ولا أحد فروعه." },
  ACTIVATION_NOT_READY: { status: 409, en: "Accounting cannot be activated yet: complete the readiness checklist.", ar: "لا يمكن تفعيل المحاسبة بعد؛ أكمل قائمة الجاهزية." },
  ALREADY_ACTIVE: { status: 409, en: "Accounting is already activated.", ar: "المحاسبة مفعّلة مسبقًا." },
  ENGINE_HAS_POSTED: { status: 409, en: "The posting engine has posted: the go-live date and the activation are final.", ar: "رحّل محرك الترحيل قيودًا؛ تاريخ البدء والتفعيل نهائيان." },
  OPENING_POSTED: { status: 409, en: "The opening balances are posted; the opening grid is final.", ar: "رُحّلت الأرصدة الافتتاحية؛ الجدول نهائي." },
  OPENING_EMPTY: { status: 409, en: "Enter at least one opening balance first.", ar: "أدخل رصيدًا افتتاحيًا واحدًا على الأقل أولًا." },
  SOD_SELF_APPROVAL: { status: 409, en: "The preparer of a journal does not approve it (segregation of duties).", ar: "مُعدّ القيد لا يعتمده (فصل المهام)." },
  JOURNAL_STATE: { status: 409, en: "The journal entry is not in a state that allows this.", ar: "حالة القيد لا تسمح بهذا الإجراء." },
  DRAFT_ONLY: { status: 409, en: "Only a draft can be edited or deleted.", ar: "تُعدَّل المسودة أو تُحذف فقط." },
  GO_LIVE_REQUIRED: { status: 400, en: "Set the go-live date first.", ar: "حدّد تاريخ بدء المحاسبة أولًا." },
  // Accounting A5 (feat/accounting-reports): the SoD setting, the period close checklist and the year-end close.
  SOD_APPROVER_POSTS: { status: 409, en: "The approver of a journal does not post it (segregation of duties: Settings › SoD).", ar: "معتمِد القيد لا يرحّله (فصل المهام: الإعدادات › فصل المهام)." },
  CLOSE_BLOCKED: { status: 409, en: "The close checklist has blocking items: resolve them first.", ar: "في قائمة الإقفال بنود مانعة؛ عالجها أولًا." },
  CLOSE_NOTE_REQUIRED: { status: 400, en: "The checklist has warnings: write a note saying why the period is closed anyway (recorded).", ar: "في قائمة الإقفال تنبيهات؛ اكتب ملاحظة بسبب الإقفال رغمها (تُسجَّل)." },
  YEAR_NOT_READY: { status: 409, en: "The year-end close needs every month locked or closed and December soft-closed (locked).", ar: "إقفال السنة يتطلب أن تكون كل الأشهر مقفلة، وديسمبر مقفلًا مؤقتًا." },
  SOURCE_DOCUMENT_ENTRY: { status: 409, en: "This entry was posted from a source document: correct it from the document (credit note, cancel, void).", ar: "هذا القيد رُحّل من مستند مصدر؛ يُصحَّح من المستند نفسه (إشعار دائن أو إلغاء أو إبطال)." },
  CLOSING_FINAL: { status: 409, en: "The year-end closing entry is final: reopening a closed year is an owner decision.", ar: "قيد إقفال السنة نهائي؛ إعادة فتح سنة مقفلة قرار للمالك." },
  YEAR_CLOSED: { status: 409, en: "This fiscal year is closed already.", ar: "هذه السنة المالية مقفلة مسبقًا." },
  LEDGER_DB: { status: 409, en: "The ledger refused the change.", ar: "رفض دفتر الأستاذ التغيير." },
} satisfies Record<string, R>;

export type RefusalCode = keyof typeof REFUSALS;

/** A coded refusal; `detail` (English) is appended to the message, `detailAr` to the Arabic. */
export function refuse(code: RefusalCode, detail?: string, detailAr?: string): AccountingError {
  const r: R = REFUSALS[code];
  return new AccountingError(detail ? `${r.en} ${detail}` : r.en, r.status, code, detailAr ? `${r.ar} ${detailAr}` : r.ar);
}

/** The database guards' refusals ("LEDGER: …"), as coded refusals (null = not one of them). */
const DB: [RegExp, RefusalCode, string][] = [
  [/LEDGER: a posted journal entry balances/, "UNBALANCED", "قيد مرحّل غير متوازن."],
  [/LEDGER: the fiscal period is closed/, "PERIOD_CLOSED", ""],
  [/LEDGER: an engine entry is never dated before the accounting go-live date/, "BEFORE_GO_LIVE", ""],
  [/LEDGER: a journal line names an active, postable leaf account/, "ACCOUNT_NOT_POSTABLE", ""],
  [/LEDGER: a line on an AR \/ AP control account names its customer or supplier/, "PARTY_REQUIRED", ""],
  [/LEDGER: an account with journal lines keeps its code, type and normal balance/, "ACCOUNT_LOCKED", ""],
  [/LEDGER: an account with journal lines cannot become a parent|LEDGER: an account cannot be moved under its own descendant|LEDGER: an account is not its own parent/, "PARENT_INVALID", ""],
  [/LEDGER: once the posting engine has posted/, "ENGINE_HAS_POSTED", ""],
  [/LEDGER: the opening balances are posted; the opening grid is final/, "OPENING_POSTED", ""],
  [/LEDGER: a closed fiscal period is reopened only with a reason/, "REASON_REQUIRED", ""],
  [/LEDGER: /, "LEDGER_DB", ""],
];

export function ledgerDbRefusal(message: string): AccountingError | null {
  if (!/LEDGER: /.test(message) || /LEDGER: manual journals are disabled/.test(message)) return null;
  const hit = DB.find(([re]) => re.test(message));
  if (!hit) return null;
  const line = (/LEDGER: [^\n]*/.exec(message)?.[0] ?? "").slice(0, 300);
  return refuse(hit[1], `(${line})`, hit[2] || undefined);
}
