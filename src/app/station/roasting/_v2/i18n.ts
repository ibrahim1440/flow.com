"use client";
/**
 * «محطة التحميص v2» — the screen's two languages (the owner's decision: every station screen bilingual, the employee's
 * preference by default, the bar's switch at any time). Arabic is the approved D12 wording; English is plain floor
 * English (Drum · Cooler · Basket · Bucket). An entry is a string with {placeholders} or a function for counted nouns.
 */
import { useMemo } from "react";
import { useStation } from "../../_ui/context";

type V = Record<string, string | number>;
type Entry = { ar: string | ((v: V) => string); en: string | ((v: V) => string) };

/** Arabic counted noun: 1 دلو · 2 دلوان · 3–10 دلاء · 11+ دلوًا. */
const arBuckets = (n: number) => (n === 1 ? "دلو" : n === 2 ? "دلوان" : n <= 10 ? "دلاء" : "دلوًا");
const arOps = (n: number) => (n === 1 ? "عملية" : n <= 10 ? "عمليات" : "عملية");
const enS = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const V2_STRINGS = {
  // ── Bar
  stationName: { ar: "محطة التحميص", en: "Roasting station" },
  roasterTabs: { ar: "الحمّاصة", en: "Roaster" },
  previousScreen: { ar: "السابقة", en: "previous screen" },
  previousScreenTitle: { ar: "الشاشة السابقة", en: "The previous screen" },
  planPill: { ar: (v) => `${v.coffee} ${v.kg} كجم · متبقٍ ${v.n} ${arBuckets(+v.n)}`, en: (v) => `${v.coffee} ${v.kg} kg · ${v.n} ${enS(+v.n, "bucket", "buckets")} left` },
  online: { ar: "متصل", en: "Online" },
  offlineShort: { ar: "دون اتصال", en: "Offline" },
  switchEmployee: { ar: "تبديل الموظف", en: "Switch employee" },
  soundOff: { ar: "إيقاف الصوت", en: "Sound off" },
  soundOn: { ar: "تشغيل الصوت", en: "Sound on" },
  prepLink: { ar: "التحضير", en: "Prep" },
  roastLink: { ar: "التحميص", en: "Roasting" },
  report: { ar: "⚠️ إبلاغ", en: "⚠️ Report" },
  scanAria: { ar: "مسح الدلو", en: "Scan the bucket" },
  loading: { ar: "جارٍ التحميل…", en: "Loading…" },
  // ── Banners
  offlineBanner: { ar: (v) => `دون اتصال · الحفظ محليًا · ${v.n} ${arOps(+v.n)} بانتظار الإرسال. تابع العمل كالمعتاد.`, en: (v) => `Offline · saved on this device · ${v.n} ${enS(+v.n, "action", "actions")} waiting to send. Keep working as usual.` },
  problemOpen: { ar: (v) => `⚠️ بلاغ مفتوح: ${v.kind} · منذ ${v.min} د`, en: (v) => `⚠️ Open problem: ${v.kind} · ${v.min} min ago` },
  kindMalfunction: { ar: "عطل في الحمّاصة", en: "Roaster malfunction" },
  kindPause: { ar: "إيقاف مؤقت", en: "Pause" },
  problemReason: { ar: (v) => `السبب: ${v.reason} · أُبلغ ${v.at}`, en: (v) => `Reason: ${v.reason} · reported ${v.at}` },
  supervisorCloses: { ar: " · يُغلقه المشرف فقط", en: " · only a supervisor closes it" },
  awaitSupervisor: { ar: "⏳ بانتظار المشرف", en: "⏳ Waiting for a supervisor" },
  resume: { ar: "استئناف", en: "Resume" },
  sessionLost: { ar: (v) => `انتهت الجلسة · سجّل الدخول لإرسال ${v.n} ${arOps(+v.n)} محفوظة`, en: (v) => `Session ended · sign in to send ${v.n} saved ${enS(+v.n, "action", "actions")}` },
  signIn: { ar: "تسجيل الدخول", en: "Sign in" },
  failed: { ar: "تعذّر الإجراء.", en: "That did not work." },
  // ── Problem reasons / loss reasons
  rBURNER_STOPPED: { ar: "توقّف الموقد", en: "Burner stopped" },
  rIRREGULAR_HEAT: { ar: "حرارة غير منتظمة", en: "Irregular heat" },
  rCOOLING_PROBLEM: { ar: "مشكلة في التبريد", en: "Cooling problem" },
  rOTHER: { ar: "أخرى", en: "Other" },
  lPROCESS: { ar: "عملية التحميص", en: "Roasting process" },
  lEQUIPMENT: { ar: "المعدّة", en: "Equipment" },
  lSAMPLE: { ar: "عيّنة مأخوذة", en: "Sample taken" },
  lUNKNOWN: { ar: "غير معروف", en: "Unknown" },
  // ── Columns
  drum: { ar: "🔥 الدرام", en: "🔥 Drum" },
  cooler: { ar: "❄️ التبريد", en: "❄️ Cooler" },
  basket: { ar: "🧺 السلّة", en: "🧺 Basket" },
  roasting: { ar: "قيد التحميص", en: "Roasting" },
  empty: { ar: "فارغ", en: "Empty" },
  emptyAwaitWeight: { ar: "فارغ · بانتظار الوزن", en: "Empty · waiting for the scale" },
  bucketCoffee: { ar: (v) => `الدلو ${v.n} · ${v.coffee}`, en: (v) => `Bucket ${v.n} · ${v.coffee}` },
  bucketN: { ar: (v) => `الدلو ${v.n}`, en: (v) => `Bucket ${v.n}` },
  roastTime: { ar: "مدة التحميص", en: "Roast time" },
  startedAt: { ar: (v) => `بدأ ${v.at} · حمصة`, en: (v) => `Started ${v.at} · roast` },
  next: { ar: "التالي", en: "Next" },
  greenKg: { ar: (v) => `${v.coffee} · ${v.kg} كجم أخضر`, en: (v) => `${v.coffee} · ${v.kg} kg green` },
  noBuckets: { ar: "لا دلاء محضّرة · افتح «التحضير»", en: "No buckets prepared · open «Prep»" },
  scanFailed: { ar: "تعذّرت قراءة الملصق · اختر الرقم", en: "Could not read the label · pick the number" },
  nextLine: { ar: (v) => `التالي: الدلو ${v.n} · ${v.coffee}`, en: (v) => `Next: bucket ${v.n} · ${v.coffee}` },
  otherBucket: { ar: "دلو آخر", en: "Another bucket" },
  gateTitle: { ar: "🔒 يُتاح التحميل بعد وزن السلّة", en: "🔒 Charging opens once the basket is weighed" },
  gateBody: { ar: (v) => `توجد حمصات مفرَّغة بلا وزن. سجّل وزنها ثم حمّل الدلو ${v.n}. يُحتسب وقت التحميل من أول ضغطة (${v.at}).`, en: (v) => `Dropped roasts are not weighed yet. Record their weight, then charge bucket ${v.n}. The charge time counts from the first tap (${v.at}).` },
  problemLockTitle: { ar: "🔒 لا يمكن التحميل أثناء وجود بلاغ مفتوح", en: "🔒 No charging while a problem is open" },
  problemLockBody: { ar: "التفريغ والوزن متاحان لإخراج البُنّ.", en: "Drop and weighing still work, to get the coffee out." },
  undoCombined: { ar: (v) => `فُرّغ الدلو ${v.a} · حُمّل الدلو ${v.b}`, en: (v) => `Dropped bucket ${v.a} · charged bucket ${v.b}` },
  undoDrop: { ar: "فُرّغت الحمصة", en: "Roast dropped" },
  undoCharge: { ar: "حُمّل الدلو", en: "Bucket charged" },
  undo: { ar: "تراجع", en: "Undo" },
  undoUntil: { ar: "متاح حتى الإجراء التالي", en: "Available until the next action" },
  chargeLocked: { ar: (v) => `تحميل الدلو ${v.n} · مقفل`, en: (v) => `Charge bucket ${v.n} · locked` },
  drop: { ar: "تفريغ", en: "Drop" },
  dropCharge: { ar: (v) => `تفريغ وتحميل الدلو ${v.n}`, en: (v) => `Drop & charge bucket ${v.n}` },
  dropOnly: { ar: "تفريغ فقط", en: "Drop only" },
  charge: { ar: (v) => `تحميل الدلو ${v.n}`, en: (v) => `Charge bucket ${v.n}` },
  afterWeighing: { ar: " · بعد الوزن", en: " · after weighing" },
  locked: { ar: " · مقفل", en: " · locked" },
  oneRoast: { ar: "حمصة واحدة", en: "One roast" },
  cooling: { ar: (v) => `قيد التبريد · ${v.t}`, en: (v) => `Cooling · ${v.t}` },
  droppedAt: { ar: (v) => `فُرّغت ${v.at} ·`, en: (v) => `Dropped ${v.at} ·` },
  noLink: { ar: "⛔ لا تُربط · بُنّ مختلف", en: "⛔ Do not pair · different coffee" },
  pairedWith: { ar: (v) => `🔗 مع الدلو ${v.n} في السلّة · تُخلطان`, en: (v) => `🔗 With bucket ${v.n} in the basket · blended together` },
  burntAsk: { ar: (v) => `تأكيد: الحمصة ${v.n} محترقة؟`, en: (v) => `Confirm: roast ${v.n} is burnt?` },
  burntYes: { ar: "نعم · محترقة", en: "Yes · burnt" },
  burnt: { ar: "🔥 محترقة", en: "🔥 Burnt" },
  burntReason: { ar: "محترقة", en: "Burnt" },
  cancel: { ar: "إلغاء", en: "Cancel" },
  coolerEmpty: { ar: "التبريد فارغ", en: "Cooler empty" },
  coolerHint: { ar: "تصل هنا عند الضغط على «تفريغ»", en: "Roasts arrive here when you tap «Drop»" },
  recordedTag: { ar: "سُجّل ✓", en: "Recorded ✓" },
  unweighed: { ar: (v) => `${v.n} بلا وزن`, en: (v) => `${v.n} not weighed` },
  kgShort: { ar: (v) => `${v.kg} كجم`, en: (v) => `${v.kg} kg` },
  lot: { ar: "الدفعة", en: "Lot" },
  labelPrinted: { ar: "🖨️ طُبع ملصق الدفعة · ألصقه على السلّة", en: "🖨️ Lot label printed · stick it on the basket" },
  reprint: { ar: "إعادة الطباعة", en: "Print again" },
  basketClears: { ar: "تُفرَّغ السلّة تلقائيًا مع التفريغ التالي", en: "The basket clears itself with the next drop" },
  weighFirst: { ar: "سجّل وزن الدفعة الموجودة في السلّة أولًا", en: "Record the weight of the lot in the basket first" },
  twoRoasts: { ar: "حمصتان", en: "Two roasts" },
  singleRoast: { ar: "حمصة منفردة", en: "Single roast" },
  kgGreen: { ar: (v) => `${v.kg} كجم أخضر`, en: (v) => `${v.kg} kg green` },
  kgRoasted: { ar: "كجم محمّص", en: "kg roasted" },
  lossAbove: { ar: "الفاقد فوق الحد · اختر السبب", en: "Loss above the limit · choose the reason" },
  recordWeight: { ar: "تسجيل الوزن", en: "Record weight" },
  recordSingle: { ar: "تسجيل منفردة", en: "Record single" },
  enterRoasted: { ar: "أدخل الوزن المحمّص.", en: "Enter the roasted weight." },
  chooseLoss: { ar: "اختر سبب الفاقد.", en: "Choose the loss reason." },
  chooseReason: { ar: "اختر السبب.", en: "Choose the reason." },
  noReturn: { ar: "⛔ لا تُعِدها · بُنّ مختلف", en: "⛔ Do not put it back · different coffee" },
  mismatchBody: { ar: (v) => `السلّة ${v.a} · التبريد ${v.b}`, en: (v) => `Basket ${v.a} · cooler ${v.b}` },
  pairReady: { ar: "حمصتان · جاهزة للوزن", en: "Two roasts · ready to weigh" },
  singleReady: { ar: "حمصة منفردة · جاهزة للوزن", en: "Single roast · ready to weigh" },
  oneLot: { ar: (v) => `${v.coffee} · ${v.kg} كجم أخضر · دفعة واحدة`, en: (v) => `${v.coffee} · ${v.kg} kg green · one lot` },
  inCoolerReturn: { ar: (v) => `في التبريد · أعِدها مع الدلو ${v.n}`, en: (v) => `In the cooler · put it back with bucket ${v.n}` },
  singleNoMate: { ar: "حمصة منفردة · بلا شريكة", en: "Single roast · no partner" },
  inBasket: { ar: "في السلّة", en: "In the basket" },
  recordSingleFirst: { ar: "سجّلها منفردة قبل تفريغ التبريد", en: "Record it as single before dropping the cooler" },
  basketEmpty: { ar: "السلّة فارغة", en: "Basket empty" },
  // ── Coffee change
  coffeeChange: { ar: "تغيّر البُنّ", en: "Coffee change" },
  coffeeChangeBody: { ar: (v) => `الدرام: ${v.a} · الدلو التالي: ${v.b}`, en: (v) => `Drum: ${v.a} · next bucket: ${v.b}` },
  coffeeChangeNote: { ar: "الحمصة التي ستُفرَّغ لا تُعاد مع حمصة من بُنّ آخر.", en: "The roast you drop is not paired with a roast of another coffee." },
  coffeeChangeYes: { ar: (v) => `تأكيد · تفريغ وتحميل ${v.coffee}`, en: (v) => `Confirm · drop & charge ${v.coffee}` },
  // ── Tray / switch
  trayTitle: { ar: "عمليات لم تُرسل", en: "Not sent" },
  anAction: { ar: "عملية", en: "Action" },
  foreignOp: { ar: (v) => `سجّلها ${v.name} · تُرسل باسمه عند دخوله فقط`, en: (v) => `Done by ${v.name} · sent only when they sign in` },
  anotherEmployee: { ar: "موظف آخر", en: "another employee" },
  waitsPrevious: { ar: "تنتظر العملية التي قبلها", en: "Waits for the action before it" },
  deleteAsk: { ar: "حذف العملية نهائيًا؟", en: "Delete this action for good?" },
  deleteWith: { ar: (v) => ` سيُحذف معها: ${v.list}`, en: (v) => ` Also deleted: ${v.list}` },
  deleteYes: { ar: "نعم · حذف", en: "Yes · delete" },
  retry: { ar: "إعادة المحاولة", en: "Try again" },
  delete: { ar: "حذف", en: "Delete" },
  notSent: { ar: (v) => `لم تُرسل «${v.title}»: ${v.reason}`, en: (v) => `Not sent «${v.title}»: ${v.reason}` },
  serverRefused: { ar: "رفض الخادم العملية.", en: "The server refused it." },
  switchBlockedTitle: { ar: "توجد عمليات لم تُرسل", en: "Some actions were not sent" },
  switchBlockedBody: { ar: (v) => `${v.n} ${arOps(+v.n)} باسم ${v.name} لم تصل إلى الخادم بعد. أرسلها أو احذفها من «عمليات لم تُرسل» قبل تبديل الموظف${v.offline ? "، أو انتظر عودة الاتصال" : ""}.`, en: (v) => `${v.n} ${enS(+v.n, "action", "actions")} by ${v.name} did not reach the server yet. Send or delete them in «Not sent» before switching employee${v.offline ? ", or wait for the connection" : ""}.` },
  ok: { ar: "حسنًا", en: "OK" },
  // ── Problem sheet
  reportTitle: { ar: "⚠️ الإبلاغ عن مشكلة", en: "⚠️ Report a problem" },
  reportSub: { ar: (v) => ` · الدلو ${v.n} قيد التحميص منذ ${v.at}`, en: (v) => ` · bucket ${v.n} roasting since ${v.at}` },
  kind: { ar: "النوع", en: "Type" },
  reason: { ar: "السبب", en: "Reason" },
  notePlaceholder: { ar: "ملاحظة قصيرة (اختياري)", en: "Short note (optional)" },
  send: { ar: "إرسال", en: "Send" },
  // ── Queued titles
  tCharge: { ar: (v) => `تحميل الدلو ${v.n}`, en: (v) => `Charge bucket ${v.n}` },
  tDrop: { ar: (v) => `تفريغ الدلو ${v.n}`, en: (v) => `Drop bucket ${v.n}` },
  tRecord: { ar: (v) => `تسجيل وزن ${v.kg} كجم`, en: (v) => `Record ${v.kg} kg` },
  // ── Lot correction (the owner's decision: the roaster corrects his own weighing, same day)
  correct: { ar: "تصحيح الوزن", en: "Correct weight" },
  correctTitle: { ar: (v) => `تصحيح وزن الدفعة ${v.lot}`, en: (v) => `Correct the weight of lot ${v.lot}` },
  correctWas: { ar: (v) => `المسجّل: ${v.kg} كجم محمّص من ${v.green} كجم أخضر`, en: (v) => `Recorded: ${v.kg} kg roasted from ${v.green} kg green` },
  correctReason: { ar: "سبب التصحيح (مطلوب)", en: "Reason for the correction (required)" },
  correctSave: { ar: "حفظ التصحيح", en: "Save correction" },
  correctNeedReason: { ar: "اكتب سبب التصحيح.", en: "Give the reason for the correction." },
  correctDone: { ar: (v) => `صُحّح الوزن · الدفعة الجديدة ${v.lot}`, en: (v) => `Weight corrected · new lot ${v.lot}` },
  correctNote: { ar: "يُبلَّغ المشرف بكل تصحيح. بعد يوم العمل يصحّحها المشرف.", en: "The supervisor is told of every correction. After the business day, a supervisor corrects it." },
  lotsToday: { ar: "آخر الدفعات", en: "Today's lots" },
  lotLine: { ar: (v) => `${v.coffee} · ${v.kg} كجم · ${v.at}`, en: (v) => `${v.coffee} · ${v.kg} kg · ${v.at}` },
  lotInUse: { ar: "استُخدمت", en: "In use" },
  lotCorrected: { ar: "مصحّحة", en: "corrected" },
  // ── Prep (P1–P3)
  prepTitle: { ar: "تحضير الدلاء · منطقة التحميص", en: "Bucket prep · roasting area" },
  roastingArea: { ar: "منطقة التحميص", en: "Roasting area" },
  prepHeading: { ar: "تحضير الدلاء", en: "Bucket prep" },
  pickLine: { ar: "اختر بندًا من خطة اليوم", en: "Pick a line from today's plan" },
  noDemand: { ar: "لا طلبات تنتظر التحميص اليوم.", en: "No orders waiting to be roasted today." },
  planLine: { ar: (v) => `${v.coffee} · ${v.kg} كجم ← ${v.n} ${arBuckets(+v.n)} × ${v.per} كجم`, en: (v) => `${v.coffee} · ${v.kg} kg → ${v.n} ${enS(+v.n, "bucket", "buckets")} × ${v.per} kg` },
  forOrders: { ar: (v) => `لطلبات #${v.list}`, en: (v) => `For orders #${v.list}` },
  forStock: { ar: "مخزون", en: "Stock" },
  preparedToday: { ar: (v) => `حُضّر ${v.n} اليوم`, en: (v) => `${v.n} prepared today` },
  readyToPrep: { ar: "جاهز للتحضير", en: "Ready to prep" },
  chosenLine: { ar: "البند المختار", en: "Chosen line" },
  coffeeKg: { ar: (v) => `${v.coffee} · ${v.kg} كجم`, en: (v) => `${v.coffee} · ${v.kg} kg` },
  suggestion: { ar: "الاقتراح", en: "Suggestion" },
  bucketsTimes: { ar: (v) => `${v.n} ${arBuckets(+v.n)} × ${v.per} كجم`, en: (v) => `${v.n} ${enS(+v.n, "bucket", "buckets")} × ${v.per} kg` },
  fromGreen: { ar: (v) => `من الدفعة الخضراء ${v.lot} · لكل دلو دفعة واحدة`, en: (v) => `From green lot ${v.lot} · one lot per bucket` },
  bucketCount: { ar: "عدد الدلاء", en: "Buckets" },
  kgPerBucket: { ar: "كجم لكل دلو", en: "kg per bucket" },
  stagingNote: { ar: "ينتقل الأخضر إلى «منطقة التحميص» (تحويل مخزون دون قيد). تبقى الدلاء المتبقية ظاهرة.", en: "The green moves to the «roasting area» (a stock transfer, no journal entry). Leftover buckets stay visible." },
  pickFromList: { ar: "اختر بندًا من القائمة.", en: "Pick a line from the list." },
  startPrep: { ar: "ابدأ التحضير", en: "Start prep" },
  noGreenLot: { ar: "لا لوت أخضر محدد لهذا البُنّ. اطلب من المشرف تحديده.", en: "No green lot is set for this coffee. Ask the supervisor to set it." },
  enterWeight: { ar: "أدخل الوزن.", en: "Enter the weight." },
  bucketOf: { ar: (v) => `دلو ${v.i} من ${v.n}`, en: (v) => `Bucket ${v.i} of ${v.n}` },
  weightHint: { ar: "الوزن (معبّأ بالمخطط) · عدّله إن اختلف الميزان", en: "Weight (planned, filled in) · change it if the scale differs" },
  keypad: { ar: "لوحة الأرقام", en: "Keypad" },
  matchPrint: { ar: "مطابق · طباعة", en: "Matches · print" },
  labelToPrint: { ar: "الملصق الذي سيُطبع", en: "Label to print" },
  lastPrinted: { ar: "آخر المطبوع", en: "Last printed" },
  printedTick: { ar: "✓ طُبع", en: "✓ Printed" },
  scaleNote: { ar: "ميزان البلوتوث: متوقف (المرحلة القادمة) · الوزن يدوي", en: "Bluetooth scale: off (next phase) · manual weight" },
  preparedSum: { ar: (v) => `حُضّر ${v.n} ${arBuckets(+v.n)} · ${v.kg} كجم`, en: (v) => `${v.n} ${enS(+v.n, "bucket", "buckets")} prepared · ${v.kg} kg` },
  inDrum: { ar: "في الدرام", en: "In the drum" },
  roastedTick: { ar: "✓ حُمّص", en: "✓ Roasted" },
  returned: { ar: "أُعيد", en: "Returned" },
  writtenOff: { ar: "شُطب", en: "Written off" },
  short: { ar: " · ناقص", en: " · short" },
  gridNote: { ar: "كل دلو بلون البُنّ على الشاشة، ورقمه الكبير على الملصق. الترتيب هو ما يقترحه الدرام.", en: "Each bucket shows its coffee's colour on screen and its big number on the label. The order is what the drum suggests." },
  anotherLine: { ar: "بند آخر", en: "Another line" },
  toRoasting: { ar: "إلى التحميص", en: "To roasting" },
  leftoverTitle: { ar: "المتبقي في منطقة التحميص", en: "Left in the roasting area" },
  leftoverCount: { ar: (v) => `تبقّت ${v.n} دلاء لم تُحمَّص`, en: (v) => `${v.n} ${enS(+v.n, "bucket", "buckets")} not roasted` },
  noLeftover: { ar: "لا دلاء متبقية من أيام سابقة", en: "No buckets left from earlier days" },
  staleSince: { ar: (v) => ` · ⚠️ منذ ${v.h} ساعة`, en: (v) => ` · ⚠️ ${v.h} hours ago` },
  returnToStock: { ar: "إعادتها إلى المخزون", en: "Return to stock" },
  returnReason: { ar: "إعادة إلى المخزون", en: "Returned to stock" },
} satisfies Record<string, Entry>;

export type V2Key = keyof typeof V2_STRINGS;
export type V2Lang = "ar" | "en";

export function v2t(lang: V2Lang, key: V2Key, v: V = {}): string {
  const e = (V2_STRINGS as Record<string, Entry>)[key][lang];
  return typeof e === "function" ? e(v) : e.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));
}

/** A coffee's name in the screen's language (the other language when one is missing). */
export function coffeeIn(lang: V2Lang, p: { productNameAr?: string | null; productNameEn?: string | null } | null | undefined): string {
  return ((lang === "en" ? p?.productNameEn || p?.productNameAr : p?.productNameAr || p?.productNameEn) || "").trim();
}

/** The screen's language — the signed-in employee's (switched from the bar) — and its helpers. */
export function useV2T() {
  const { user } = useStation();
  const lang: V2Lang = user.preferredLanguage === "en" ? "en" : "ar";
  return useMemo(() => ({
    lang,
    dir: (lang === "en" ? "ltr" : "rtl") as "ltr" | "rtl",
    t: (key: V2Key, v?: V) => v2t(lang, key, v),
    coffee: (p: Parameters<typeof coffeeIn>[1]) => coffeeIn(lang, p),
    /** The server's message in the screen's language (every refusal carries errorAr / errorEn). */
    err: (b: { error?: string; errorEn?: string } | null | undefined, fallback?: string) => (lang === "en" ? b?.errorEn || b?.error : b?.error || b?.errorEn) || fallback || v2t(lang, "failed"),
  }), [lang]);
}
