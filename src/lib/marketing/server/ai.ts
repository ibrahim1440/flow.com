import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { prisma, TX_OPTS } from "@/lib/db";
import { MktError, str, num, oneOf, strList, type Actor, can, denied } from "./http";
import { audit, userActor } from "./audit";
import { PLATFORM, SOCIAL_PLATFORMS } from "../platforms";
import { commandCenter } from "./overview";
import { loadSettings } from "./settings";
import { localDayStart } from "../messaging-rules";
import { lastDays } from "../kpi";

/**
 * The AI studio and the AI marketing manager, on the Claude API (official SDK, server-side key).
 *
 * ── What it may and may not do ──
 * It drafts. Every output is saved as a DRAFT (post or copy asset) flagged aiGenerated, and the
 * approval policy for AI content applies (required unless the owner switched it off). It is given the brand kit,
 * the product's own catalogue fields and — for strategy — the system's real figures, and it is told
 * to separate facts it was given from assumptions and never to invent prices, discounts, awards or
 * market data. Each call is audited with the model and token usage.
 */

export const DEFAULT_AI_MODEL = "claude-opus-5-5";

function client() {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new MktError("استوديو الذكاء الاصطناعي غير مفعّل: مفتاح ANTHROPIC_API_KEY غير مضبوط على الخادم.", "ANTHROPIC_API_KEY is not configured.", 409, "MKT_AI_OFF");
  return new Anthropic({ apiKey: key, timeout: 120_000, maxRetries: 2 });
}

export function aiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

const model = () => process.env.MARKETING_AI_MODEL?.trim() || DEFAULT_AI_MODEL;

async function brandContext() {
  const kit = await prisma.mktBrandKit.findUnique({ where: { id: "default" } });
  return {
    brand: kit?.brandNameAr ?? "حقبة",
    brandEn: kit?.brandNameEn ?? "Hiqbah",
    tone: kit?.toneAr ?? null,
    do: kit?.doList ?? [],
    dont: kit?.dontList ?? [],
    examples: (kit?.examples ?? []).slice(0, 5),
  };
}

async function productContext(productId: string | null) {
  if (!productId) return null;
  const p = await prisma.coffeeProduct.findUnique({
    where: { id: productId },
    select: { productNameAr: true, productNameEn: true, countryAr: true, countryEn: true, regionAr: true, varietyAr: true, processAr: true, altitude: true, cupNotesAr: true, cupNotesEn: true, productSkus: { select: { skuCode: true, weightGrams: true } } },
  });
  return p;
}

const SYSTEM = `أنت مدير تسويق ومحرر محتوى لعلامة قهوة مختصة سعودية. تكتب بالعربية الفصحى المبسطة ما لم يُطلب غير ذلك.
قواعد ملزمة:
- استخدم فقط الحقائق المعطاة لك في الطلب (المنتج، العلامة، الأرقام). لا تخترع أسعاراً أو خصومات أو جوائز أو إحصاءات سوق أو أقوال عملاء.
- إذا احتجت معلومة غير معطاة فاذكرها في "assumptions" ولا تكتبها كحقيقة في النص.
- التزم بنبرة العلامة وقائمة الممنوعات. لا تَعِد بشيء مالي.
- اكتب نصوصاً مناسبة لحد كل منصة.`;

type Usage = { input_tokens: number; output_tokens: number };

/**
 * Daily cost guard, counted from the audit trail (every model call writes one «ai.*» row): per person
 * MARKETING_AI_DAILY_PER_USER (default 30) and for the whole company MARKETING_AI_DAILY_TOTAL (default 150),
 * per local day of the marketing settings' time zone. Checked before the model is called.
 */
export function aiDailyLimits(env: Record<string, string | undefined> = process.env) {
  const n = (v: string | undefined, d: number) => { const x = Number(v); return Number.isInteger(x) && x >= 0 && x <= 10_000 ? x : d; };
  return { perUser: n(env.MARKETING_AI_DAILY_PER_USER, 30), total: n(env.MARKETING_AI_DAILY_TOTAL, 150) };
}

async function guardDailyQuota(actor: Actor) {
  const lim = aiDailyLimits();
  const s = await loadSettings();
  const since = localDayStart(new Date(), s.timezone);
  const where = { action: { startsWith: "ai." }, at: { gte: since } };
  const [mine, all] = await Promise.all([prisma.mktAuditLog.count({ where: { ...where, actorId: actor.id } }), prisma.mktAuditLog.count({ where })]);
  if (mine >= lim.perUser) throw new MktError(`بلغت الحد اليومي لطلبات الذكاء الاصطناعي (${lim.perUser}). يتجدد غداً.`, "Daily AI limit reached for this user.", 429, "MKT_AI_QUOTA");
  if (all >= lim.total) throw new MktError(`بلغت الشركة الحد اليومي لطلبات الذكاء الاصطناعي (${lim.total}). يتجدد غداً.`, "Daily AI limit reached.", 429, "MKT_AI_QUOTA");
}

async function call<T>(user: string, schema: Record<string, unknown>, effort: "low" | "medium" | "high"): Promise<{ data: T; usage: Usage; servedBy: string }> {
  const c = client();
  let res;
  try {
    res = await c.beta.messages.create({
      model: model(),
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort, format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: user }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new MktError("خدمة الذكاء الاصطناعي مشغولة؛ حاول بعد قليل.", "AI rate limited.", 429, "MKT_AI_BUSY");
    if (e instanceof Anthropic.AuthenticationError) throw new MktError("مفتاح الذكاء الاصطناعي مرفوض.", "AI key rejected.", 502, "MKT_AI_KEY");
    if (e instanceof Anthropic.APIError) throw new MktError(`تعذر الاتصال بخدمة الذكاء الاصطناعي (${e.status ?? "—"}).`, "AI request failed.", 502, "MKT_AI_FAILED");
    throw new MktError("تعذر الوصول إلى خدمة الذكاء الاصطناعي.", "AI unreachable.", 502, "MKT_AI_FAILED");
  }
  if (res.stop_reason === "refusal") throw new MktError("رفض النموذج هذا الطلب؛ عدّل الصياغة.", "The model declined.", 422, "MKT_AI_REFUSED");
  if (res.stop_reason === "max_tokens") throw new MktError("المخرجات أطول من المسموح؛ قلّل عدد النسخ.", "Output truncated.", 422, "MKT_AI_TRUNCATED");
  const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  try {
    return { data: JSON.parse(text) as T, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, servedBy: res.model };
  } catch {
    throw new MktError("مخرجات غير صالحة من النموذج.", "Invalid model output.", 502, "MKT_AI_FAILED");
  }
}

// ── Copy variants ──────────────────────────────────────────────────────────────────────────

const COPY_SCHEMA = {
  type: "object", additionalProperties: false, required: ["variants", "assumptions", "notes"],
  properties: {
    variants: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["platform", "angle", "headline", "caption", "hashtags", "cta"],
        properties: { platform: { type: "string" }, angle: { type: "string" }, headline: { type: "string" }, caption: { type: "string" }, hashtags: { type: "array", items: { type: "string" } }, cta: { type: "string" } },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
};

export type CopyResult = { variants: { platform: string; angle: string; headline: string; caption: string; hashtags: string[]; cta: string }[]; assumptions: string[]; notes: string };

export async function generateCopy(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "ai_use")) throw denied();
  await guardDailyQuota(actor);
  const platforms = strList(body.platforms, "المنصات", 6).filter((p) => SOCIAL_PLATFORMS.includes(p));
  if (!platforms.length) throw new MktError("اختر منصة واحدة على الأقل.", "Choose a platform.");
  const count = num(body.count, "عدد النسخ", { min: 1, max: 5, int: true }) ?? 3;
  const brief = {
    objective: str(body.objective, "الهدف", { max: 200, required: true }), audience: str(body.audience, "الجمهور", { max: 500 }),
    message: str(body.message, "الرسالة", { max: 1000, required: true }), offer: str(body.offer, "العرض", { max: 500 }),
    cta: str(body.cta, "الدعوة لاتخاذ إجراء", { max: 100 }), language: oneOf(body.language, ["ar", "en"] as const, "اللغة", "ar"),
  };
  const productId = str(body.productId, "المنتج");
  const [brand, product] = await Promise.all([brandContext(), productContext(productId)]);
  const limits = platforms.map((p) => `${p}: ${PLATFORM[p].limits?.captionMax ?? "—"} حرفاً${PLATFORM[p].limits?.hashtagsMax ? `، حتى ${PLATFORM[p].limits!.hashtagsMax} وسماً` : ""}`);
  const prompt = `اكتب ${count} نسخ إعلانية مختلفة الزاوية لكل منصة من: ${platforms.join("، ")}.
حدود المنصات: ${limits.join(" | ")}
لغة النص: ${brief.language === "ar" ? "العربية" : "الإنجليزية"}
الموجز: ${JSON.stringify(brief)}
العلامة: ${JSON.stringify(brand)}
المنتج (حقائق من النظام): ${product ? JSON.stringify(product) : "لا يوجد منتج محدد"}
اكتب الوسوم بلا علامة #. اذكر في assumptions كل ما افترضته.`;
  const r = await call<CopyResult>(prompt, COPY_SCHEMA, "medium");
  await prisma.$transaction((tx) => audit(tx, userActor(actor), "ai.copy_generated", "MktAsset", null, { after: { model: r.servedBy, usage: r.usage, platforms, count } }), TX_OPTS);
  return { ...r.data, model: r.servedBy, usage: r.usage };
}

// ── Strategy / monthly plan (AI marketing manager) ─────────────────────────────────────────

const PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["summary", "situation", "swot", "objectives", "segments", "channels", "calendar", "experiments", "risks", "dataUsed", "assumptions"],
  properties: {
    summary: { type: "string" },
    situation: { type: "string" },
    swot: { type: "object", additionalProperties: false, required: ["strengths", "weaknesses", "opportunities", "threats"], properties: { strengths: { type: "array", items: { type: "string" } }, weaknesses: { type: "array", items: { type: "string" } }, opportunities: { type: "array", items: { type: "string" } }, threats: { type: "array", items: { type: "string" } } } },
    objectives: { type: "array", items: { type: "object", additionalProperties: false, required: ["objective", "kpi", "target", "deadline", "basis"], properties: { objective: { type: "string" }, kpi: { type: "string" }, target: { type: "string" }, deadline: { type: "string" }, basis: { type: "string" } } } },
    segments: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "needs", "objections", "message"], properties: { name: { type: "string" }, needs: { type: "string" }, objections: { type: "string" }, message: { type: "string" } } } },
    channels: { type: "array", items: { type: "object", additionalProperties: false, required: ["platform", "role", "budgetSharePct", "why"], properties: { platform: { type: "string" }, role: { type: "string" }, budgetSharePct: { type: "number" }, why: { type: "string" } } } },
    calendar: { type: "array", items: { type: "object", additionalProperties: false, required: ["week", "platform", "contentType", "idea", "objective"], properties: { week: { type: "integer" }, platform: { type: "string" }, contentType: { type: "string" }, idea: { type: "string" }, objective: { type: "string" } } } },
    experiments: { type: "array", items: { type: "object", additionalProperties: false, required: ["hypothesis", "test", "successMetric"], properties: { hypothesis: { type: "string" }, test: { type: "string" }, successMetric: { type: "string" } } } },
    risks: { type: "array", items: { type: "string" } },
    dataUsed: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
  },
};

export async function generatePlan(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "ai_use")) throw denied();
  await guardDailyQuota(actor);
  const horizon = oneOf(body.horizon, ["MONTH", "QUARTER", "YEAR"] as const, "المدى", "MONTH");
  const goal = str(body.goal, "الهدف التجاري", { max: 1000, required: true });
  const budget = num(body.budget, "الميزانية", { min: 0 });
  const constraints = str(body.constraints, "القيود والمواسم", { max: 2000 });
  const { from, to } = lastDays(30);
  const cc = await commandCenter(from, to, actor);
  const facts = {
    last30Days: Object.fromEntries(Object.entries(cc.figures).map(([k, f]) => [k, f.value])),
    platforms: cc.platforms.map((p) => ({ platform: p.platform, spend: p.spend, ctr: p.ctr, cpc: p.cpc })),
    best: cc.best.map((b) => ({ name: b.name, objective: b.objective, score: b.score, kpi: b.scoreKpi })),
    tracking: cc.tracking,
  };
  const products = await prisma.coffeeProduct.findMany({ where: { isActive: true }, select: { id: true, productNameAr: true, countryAr: true, processAr: true, cupNotesAr: true, mktEconomics: { select: { grossMarginPct: true, targetCac: true } } }, take: 40 });
  const brand = await brandContext();
  const prompt = `ضع خطة تسويق لمدى ${horizon === "MONTH" ? "شهر" : horizon === "QUARTER" ? "ربع سنة" : "سنة"}.
الهدف التجاري: ${goal}
الميزانية المتاحة: ${budget === null ? "غير محددة" : `${budget} ر.س`}
قيود ومواسم: ${constraints ?? "—"}
أرقام النظام الفعلية لآخر 30 يوماً (null تعني غير متاح، وليست صفراً): ${JSON.stringify(facts)}
المنتجات النشطة: ${JSON.stringify(products)}
العلامة: ${JSON.stringify(brand)}
اجعل الأهداف SMART وكل هدف بمؤشر قياس، واذكر في basis البيانات التي استندت إليها، وفي dataUsed مصادرك من المعطيات، وفي assumptions كل افتراض. لا تذكر بيانات سوق أو منافسين لم تُعطَ لك.`;
  const r = await call<Record<string, unknown>>(prompt, PLAN_SCHEMA, "high");
  const saved = await prisma.$transaction(async (tx) => {
    const a = await tx.mktAsset.create({ data: { title: `خطة تسويق (${horizon}) — ${new Date().toISOString().slice(0, 10)}`, kind: "COPY", tags: ["strategy", "ai"], text: String((r.data as { summary?: string }).summary ?? ""), brief: { horizon, goal, budget, constraints, plan: r.data, facts } as never, aiGenerated: true, createdById: actor.id } });
    await audit(tx, userActor(actor), "ai.plan_generated", "MktAsset", a.id, { after: { model: r.servedBy, usage: r.usage, horizon } });
    return a;
  }, TX_OPTS);
  return { plan: r.data, assetId: saved.id, model: r.servedBy, usage: r.usage, facts };
}

// ── Review: language, brand rules, risky claims ────────────────────────────────────────────

const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["issues", "corrected"],
  properties: {
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["kind", "excerpt", "suggestion"], properties: { kind: { type: "string", enum: ["spelling", "grammar", "brand", "claim", "length", "clarity"] }, excerpt: { type: "string" }, suggestion: { type: "string" } } } },
    corrected: { type: "string" },
  },
};

export async function reviewText(body: Record<string, unknown>, actor: Actor) {
  if (!can(actor, "ai_use")) throw denied();
  await guardDailyQuota(actor);
  const text = str(body.text, "النص", { max: 5000, required: true })!;
  const platform = str(body.platform, "المنصة");
  const brand = await brandContext();
  const r = await call<{ issues: { kind: string; excerpt: string; suggestion: string }[]; corrected: string }>(
    `راجع النص التالي لغوياً وإملائياً ومن حيث الالتزام بالعلامة والادعاءات التي تحتاج دليلاً${platform ? ` ومناسبته لمنصة ${platform}` : ""}. لا تغيّر أسماء المنتجات أو الأرقام. أعد نسخة مصححة.\nالعلامة: ${JSON.stringify(brand)}\nالنص:\n${text}`,
    REVIEW_SCHEMA, "low",
  );
  await prisma.$transaction((tx) => audit(tx, userActor(actor), "ai.review", "MktAsset", null, { after: { model: r.servedBy, usage: r.usage } }), TX_OPTS);
  return { ...r.data, model: r.servedBy };
}
