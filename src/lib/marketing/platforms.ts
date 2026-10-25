// The platform registry: every external service the marketing department talks to, what its
// OFFICIAL interface allows, what this build actually implements, and what the company must
// obtain before it works. Pure — the integrations screen renders it as is, so it can never claim
// more than this file says.
//
// ── Status words (adapter) ──
//   IMPLEMENTED   code path exists and is covered by tests against recorded/mocked responses;
//                 NOT verified against the company's live account until a connection check passes.
//   MANUAL        no API path in this build: the system prepares the content, a person publishes
//                 it on the platform and confirms with the live URL (recorded and audited).
//   PLANNED       listed so the gap is visible; nothing in the UI pretends otherwise.
//
// The content limits are the platforms' published limits as known when this file was written
// (Oct 2026). They are used to WARN before publishing; the platform remains the authority.

export type PlatformKind = "social" | "ads" | "analytics" | "messaging" | "store" | "ai";
export type AdapterStatus = "IMPLEMENTED" | "MANUAL" | "PLANNED";

export type PlatformDef = {
  key: string;
  ar: string;
  en: string;
  kind: PlatformKind;
  /** Organic publishing through the official API. */
  organic: { adapter: AdapterStatus; noteAr: string } | null;
  /** Paid media through the official API. */
  ads: { adapter: AdapterStatus; noteAr: string } | null;
  /** What the company must have (accounts, app review, approvals, paid plan). */
  requirementsAr: string[];
  /** Server environment variables this integration reads (names only). */
  env: string[];
  docs: string;
  limits?: { captionMax?: number; hashtagsMax?: number; titleMax?: number; media: string[]; nativeScheduling: boolean };
  /** Phase of docs/marketing/ROADMAP.md that completes it. */
  phase: 1 | 2 | 3 | 4 | 5;
};

export const PLATFORMS: PlatformDef[] = [
  {
    key: "FACEBOOK", ar: "فيسبوك", en: "Facebook Page", kind: "social", phase: 2,
    organic: { adapter: "IMPLEMENTED", noteAr: "نشر نص/رابط/صورة على الصفحة عبر Graph API (/{page-id}/feed و /photos)." },
    ads: { adapter: "PLANNED", noteAr: "Meta Marketing API — قراءة الحملات والإنفاق في المرحلة الثالثة." },
    requirementsAr: ["تطبيق Meta للمطورين مرتبط بـ Business Manager", "صلاحيات pages_manage_posts و pages_read_engagement (تتطلب App Review)", "Page access token طويل الأمد"],
    env: ["META_APP_ID", "META_APP_SECRET", "META_GRAPH_VERSION"],
    docs: "https://developers.facebook.com/docs/pages-api/posts",
    limits: { captionMax: 63206, media: ["image", "video", "link"], nativeScheduling: true },
  },
  {
    key: "INSTAGRAM", ar: "إنستقرام", en: "Instagram", kind: "social", phase: 2,
    organic: { adapter: "IMPLEMENTED", noteAr: "نشر صورة عبر Content Publishing API (إنشاء حاوية ثم media_publish). القصص والريلز يدوياً في هذا الإصدار." },
    ads: { adapter: "PLANNED", noteAr: "ضمن Meta Marketing API." },
    requirementsAr: ["حساب Instagram احترافي مرتبط بصفحة فيسبوك", "صلاحية instagram_content_publish (App Review)", "الصورة برابط عام HTTPS يمكن لـ Meta جلبه"],
    env: ["META_APP_ID", "META_APP_SECRET", "META_GRAPH_VERSION"],
    docs: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
    limits: { captionMax: 2200, hashtagsMax: 30, media: ["image", "video", "carousel"], nativeScheduling: false },
  },
  {
    key: "TIKTOK", ar: "تيك توك", en: "TikTok", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "Content Posting API يتطلب تدقيق التطبيق؛ قبل التدقيق يُنشر المحتوى خاصاً فقط، لذا النشر يدوي حالياً." },
    ads: { adapter: "PLANNED", noteAr: "TikTok Business API (REST مباشر؛ حزمة SDK الرسمية غير مؤكدة المصدر — انظر OSS-VETTING)." },
    requirementsAr: ["حساب TikTok for Business", "تطبيق مطور مدقَّق لنشر عام", "حساب إعلاني ووصول Marketing API"],
    env: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],
    docs: "https://developers.tiktok.com/doc/content-posting-api-get-started",
    limits: { captionMax: 2200, media: ["video", "image"], nativeScheduling: false },
  },
  {
    key: "SNAPCHAT", ar: "سناب شات", en: "Snapchat", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "لا يوجد API عام لنشر القصص العضوية للحسابات العامة؛ النشر يدوي." },
    ads: { adapter: "PLANNED", noteAr: "Snapchat Marketing API (OAuth2، REST)." },
    requirementsAr: ["Snapchat Business Manager", "تطبيق OAuth معتمد للـ Marketing API"],
    env: ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET"],
    docs: "https://developers.snap.com/api/marketing-api",
    limits: { media: ["video", "image"], nativeScheduling: false },
  },
  {
    key: "X", ar: "إكس (تويتر)", en: "X", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "نشر التغريدات عبر X API v2 يتطلب باقة مدفوعة؛ يدوي حتى يُعتمد الاشتراك." },
    ads: { adapter: "PLANNED", noteAr: "X Ads API يتطلب موافقة منفصلة." },
    requirementsAr: ["اشتراك X API (Basic أو أعلى) للكتابة", "موافقة X Ads API للإعلانات"],
    env: ["X_CLIENT_ID", "X_CLIENT_SECRET"],
    docs: "https://docs.x.com/x-api/posts/creation-of-a-post",
    limits: { captionMax: 280, media: ["image", "video"], nativeScheduling: false },
  },
  {
    key: "YOUTUBE", ar: "يوتيوب", en: "YouTube", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "رفع الفيديو عبر YouTube Data API يحتاج OAuth وحصة يومية؛ يدوي في هذا الإصدار." },
    ads: { adapter: "PLANNED", noteAr: "إعلانات يوتيوب عبر Google Ads API." },
    requirementsAr: ["مشروع Google Cloud مع YouTube Data API v3", "شاشة موافقة OAuth موثّقة"],
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    docs: "https://developers.google.com/youtube/v3/guides/uploading_a_video",
    limits: { titleMax: 100, captionMax: 5000, media: ["video"], nativeScheduling: true },
  },
  {
    key: "LINKEDIN", ar: "لينكدإن", en: "LinkedIn", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "Posts API لصفحات الشركات يتطلب Community Management API المعتمد." },
    ads: null,
    requirementsAr: ["صفحة شركة", "اعتماد LinkedIn Community Management API"],
    env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"],
    docs: "https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api",
    limits: { captionMax: 3000, media: ["image", "video", "link"], nativeScheduling: false },
  },
  {
    key: "PINTEREST", ar: "بنترست", en: "Pinterest", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "Pinterest API v5 يتيح إنشاء الدبابيس بعد اعتماد التطبيق؛ يدوي حالياً." },
    ads: null,
    requirementsAr: ["حساب Pinterest للأعمال", "تطبيق Pinterest معتمد بصلاحية pins:write"],
    env: ["PINTEREST_APP_ID", "PINTEREST_APP_SECRET"],
    docs: "https://developers.pinterest.com/docs/api/v5/pins-create",
    limits: { titleMax: 100, captionMax: 500, media: ["image", "video"], nativeScheduling: false },
  },
  {
    key: "GOOGLE_BUSINESS", ar: "ملف جوجل التجاري", en: "Google Business Profile", kind: "social", phase: 3,
    organic: { adapter: "MANUAL", noteAr: "منشورات الملف التجاري عبر Business Profile APIs تتطلب طلب وصول من Google." },
    ads: null,
    requirementsAr: ["ملف تجاري موثّق", "الموافقة على Business Profile APIs"],
    env: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    docs: "https://developers.google.com/my-business",
    limits: { captionMax: 1500, media: ["image"], nativeScheduling: false },
  },
  {
    key: "META_ADS", ar: "إعلانات ميتا", en: "Meta Ads", kind: "ads", phase: 3,
    organic: null,
    ads: { adapter: "PLANNED", noteAr: "قراءة الحملات والإنفاق والنتائج (ads_read)، ثم التعديل (ads_management) بموافقة." },
    requirementsAr: ["حساب إعلاني في Business Manager", "Marketing API: ads_read ثم ads_management (App Review)"],
    env: ["META_APP_ID", "META_APP_SECRET", "META_GRAPH_VERSION"],
    docs: "https://developers.facebook.com/docs/marketing-api/insights",
  },
  {
    key: "TIKTOK_ADS", ar: "إعلانات تيك توك", en: "TikTok Ads", kind: "ads", phase: 3,
    organic: null, ads: { adapter: "PLANNED", noteAr: "TikTok Business API — التقارير ثم إدارة الحملات." },
    requirementsAr: ["TikTok Ads Manager", "وصول Marketing API للتطبيق"], env: ["TIKTOK_APP_ID", "TIKTOK_APP_SECRET"],
    docs: "https://business-api.tiktok.com/portal/docs",
  },
  {
    key: "SNAP_ADS", ar: "إعلانات سناب", en: "Snap Ads", kind: "ads", phase: 3,
    organic: null, ads: { adapter: "PLANNED", noteAr: "Snapchat Marketing API — الإحصاءات ثم الإدارة." },
    requirementsAr: ["حساب إعلاني", "تطبيق OAuth"], env: ["SNAP_CLIENT_ID", "SNAP_CLIENT_SECRET"],
    docs: "https://developers.snap.com/api/marketing-api",
  },
  {
    key: "GOOGLE_ADS", ar: "إعلانات جوجل", en: "Google Ads", kind: "ads", phase: 3,
    organic: null, ads: { adapter: "PLANNED", noteAr: "Google Ads API عبر REST الرسمي (لا مكتبة Node رسمية؛ انظر OSS-VETTING)." },
    requirementsAr: ["حساب Google Ads (MCC يُفضّل)", "Developer token بوصول Basic على الأقل", "OAuth"],
    env: ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    docs: "https://developers.google.com/google-ads/api/rest/overview",
  },
  {
    key: "X_ADS", ar: "إعلانات إكس", en: "X Ads", kind: "ads", phase: 3,
    organic: null, ads: { adapter: "PLANNED", noteAr: "يتطلب موافقة X Ads API." },
    requirementsAr: ["موافقة X Ads API"], env: ["X_CLIENT_ID", "X_CLIENT_SECRET"], docs: "https://docs.x.com/x-ads-api/introduction",
  },
  {
    key: "GA4", ar: "Google Analytics 4", en: "Google Analytics 4", kind: "analytics", phase: 3,
    organic: null, ads: null,
    requirementsAr: ["خاصية GA4", "حساب خدمة بصلاحية قراءة على الخاصية", "Analytics Data API مفعّل"],
    env: ["GA4_PROPERTY_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"], docs: "https://developers.google.com/analytics/devguides/reporting/data/v1",
  },
  {
    key: "GTM", ar: "Google Tag Manager", en: "Google Tag Manager", kind: "analytics", phase: 3,
    organic: null, ads: null,
    requirementsAr: ["حاوية GTM", "صلاحية قراءة؛ أي نشر لإصدار جديد يمر بموافقة واختبار (لا ينشر النظام تلقائياً)"],
    env: ["GTM_ACCOUNT_ID", "GTM_CONTAINER_ID", "GOOGLE_SERVICE_ACCOUNT_JSON"], docs: "https://developers.google.com/tag-platform/tag-manager/api/v2",
  },
  {
    key: "SEARCH_CONSOLE", ar: "Google Search Console", en: "Search Console", kind: "analytics", phase: 3,
    organic: null, ads: null,
    requirementsAr: ["موقع موثّق في Search Console", "حساب خدمة مضاف كمستخدم"],
    env: ["GSC_SITE_URL", "GOOGLE_SERVICE_ACCOUNT_JSON"], docs: "https://developers.google.com/webmaster-tools/v1/searchanalytics/query",
  },
  {
    key: "WHATSAPP_CLOUD", ar: "واتساب للأعمال (Cloud API)", en: "WhatsApp Business Cloud API", kind: "messaging", phase: 1,
    organic: null, ads: null,
    requirementsAr: [
      "حساب WhatsApp Business على Meta Cloud API (رقم مخصص وموثّق)",
      "قوالب رسائل معتمدة من Meta لكل رسالة تبدأها الشركة",
      "موافقة صريحة من العميل على الرسائل التسويقية، وخيار إلغاء الاشتراك",
      "تُحتسب تكلفة لكل رسالة حسب الفئة والدولة (تسعير Meta)",
    ],
    env: ["WHATSAPP_CLOUD_TOKEN", "WHATSAPP_CLOUD_PHONE_NUMBER_ID", "WHATSAPP_CLOUD_WABA_ID", "WHATSAPP_CLOUD_APP_SECRET", "WHATSAPP_CLOUD_VERIFY_TOKEN", "META_GRAPH_VERSION", "MARKETING_WA_LIVE_ENABLED"],
    docs: "https://developers.facebook.com/docs/whatsapp/cloud-api",
  },
  {
    key: "KARZOUN", ar: "كرزون (واتساب للأعمال — شريك Meta)", en: "Karzoun (WhatsApp BSP)", kind: "messaging", phase: 1,
    organic: null, ads: null,
    requirementsAr: [
      "كرزون شريك رسمي لـ Meta (WhatsApp Solution Partner) ويرسل عبر Cloud API — ليس واجهة غير رسمية",
      "مفتاح API من نوع «مساحة العمل» (Developer › API keys) بأقل صلاحيات لازمة، ومعرّف تكامل الواتساب",
      "القوالب تُنشأ وتُعتمد في كرزون/WhatsApp Manager ثم «مزامنة» هنا",
      "Webhook من كرزون (core:customer.update) لمزامنة إلغاء الاشتراك، موقّع بـ X-Karzoun-Signature-256",
      "إذا كانت أتمتة السلة المتروكة مفعّلة داخل كرزون نفسه فأوقف إحداهما حتى لا يصل العميل تذكيران",
    ],
    env: ["KARZOUN_API_URL", "KARZOUN_API_KEY", "KARZOUN_WA_INTEGRATION_ID", "KARZOUN_WEBHOOK_SECRET", "MARKETING_WA_LIVE_ENABLED"],
    docs: "https://github.com/KarzounApps/docs",
  },
  {
    key: "STORE", ar: "المتجر الإلكتروني", en: "Online store", kind: "store", phase: 1,
    organic: null, ads: null,
    requirementsAr: [
      "مستقبل Webhooks موقّع (HMAC) بصيغة موحّدة «Hiqbah Store Webhook v1» + استيراد CSV معلن كإدخال يدوي",
      "ربط سلة المباشر يُبنى ضمن مسار ربط سلة في النظام ويغذي الصيغة نفسها",
    ],
    env: ["STORE_WEBHOOK_SECRET"], docs: "",
  },
  {
    key: "ANTHROPIC", ar: "Claude (الذكاء الاصطناعي)", en: "Claude API", kind: "ai", phase: 1,
    organic: null, ads: null,
    requirementsAr: ["مفتاح Anthropic API على الخادم فقط", "تكلفة حسب الاستخدام", "كل مخرجات الاستوديو مسودات تمر بالموافقة"],
    env: ["ANTHROPIC_API_KEY", "MARKETING_AI_MODEL"], docs: "https://docs.claude.com/en/api/messages",
  },
];

export const PLATFORM: Record<string, PlatformDef> = Object.fromEntries(PLATFORMS.map((p) => [p.key, p]));

/** The platforms a post can target (organic social). */
export const SOCIAL_PLATFORMS = PLATFORMS.filter((p) => p.kind === "social").map((p) => p.key);

export function platformLabel(key: string, lang: "ar" | "en" = "ar"): string {
  const p = PLATFORM[key];
  return p ? (lang === "ar" ? p.ar : p.en) : key;
}

/** Which env names of a platform are missing (names only; never values). */
export function missingEnv(p: PlatformDef, env: Record<string, string | undefined> = process.env): string[] {
  return p.env.filter((k) => !env[k]?.trim() && !["META_GRAPH_VERSION", "MARKETING_AI_MODEL", "MARKETING_WA_LIVE_ENABLED"].includes(k));
}

/** Pre-publish warnings for one platform variant: caption length, hashtags, media. */
export function variantWarnings(platform: string, caption: string, hashtags: string[], mediaKinds: string[]): string[] {
  const p = PLATFORM[platform];
  const out: string[] = [];
  if (!p?.limits) return out;
  const text = [caption, hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")].filter(Boolean).join("\n\n");
  if (p.limits.captionMax && [...text].length > p.limits.captionMax) out.push(`النص أطول من حد ${p.ar} (${p.limits.captionMax} حرفاً).`);
  if (p.limits.hashtagsMax && hashtags.length > p.limits.hashtagsMax) out.push(`عدد الوسوم يتجاوز حد ${p.ar} (${p.limits.hashtagsMax}).`);
  const needsMedia = ["INSTAGRAM", "TIKTOK", "YOUTUBE", "PINTEREST", "SNAPCHAT"].includes(platform);
  if (needsMedia && mediaKinds.length === 0) out.push(`${p.ar} يتطلب صورة أو فيديو.`);
  if (platform === "TIKTOK" || platform === "YOUTUBE") {
    if (mediaKinds.length && !mediaKinds.includes("video")) out.push(`${p.ar} يحتاج فيديو.`);
  }
  return out;
}

/** Recommended aspect ratios (Creative studio guidance). */
export const ASPECT_GUIDE: { platform: string; format: string; ratio: string; px: string }[] = [
  { platform: "INSTAGRAM", format: "منشور", ratio: "4:5", px: "1080×1350" },
  { platform: "INSTAGRAM", format: "قصة / ريلز", ratio: "9:16", px: "1080×1920" },
  { platform: "FACEBOOK", format: "منشور", ratio: "1:1 أو 4:5", px: "1080×1080" },
  { platform: "TIKTOK", format: "فيديو", ratio: "9:16", px: "1080×1920" },
  { platform: "SNAPCHAT", format: "قصة / إعلان", ratio: "9:16", px: "1080×1920" },
  { platform: "X", format: "صورة", ratio: "16:9", px: "1600×900" },
  { platform: "YOUTUBE", format: "فيديو / Shorts", ratio: "16:9 / 9:16", px: "1920×1080 / 1080×1920" },
  { platform: "LINKEDIN", format: "منشور", ratio: "1.91:1 أو 1:1", px: "1200×627" },
  { platform: "PINTEREST", format: "دبوس", ratio: "2:3", px: "1000×1500" },
];
