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
export function variantWarnings(platform: string, caption: string, hashtags: string[], mediaKinds: string[], lang: "ar" | "en" = "ar"): string[] {
  const p = PLATFORM[platform];
  const out: string[] = [];
  if (!p?.limits) return out;
  const text = [caption, hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")].filter(Boolean).join("\n\n");
  if (p.limits.captionMax && [...text].length > p.limits.captionMax) out.push(lang === "en" ? `The text is longer than the ${p.en} limit (${p.limits.captionMax} characters).` : `النص أطول من حد ${p.ar} (${p.limits.captionMax} حرفاً).`);
  if (p.limits.hashtagsMax && hashtags.length > p.limits.hashtagsMax) out.push(lang === "en" ? `More hashtags than the ${p.en} limit (${p.limits.hashtagsMax}).` : `عدد الوسوم يتجاوز حد ${p.ar} (${p.limits.hashtagsMax}).`);
  const needsMedia = ["INSTAGRAM", "TIKTOK", "YOUTUBE", "PINTEREST", "SNAPCHAT"].includes(platform);
  if (needsMedia && mediaKinds.length === 0) out.push(lang === "en" ? `${p.en} needs an image or a video.` : `${p.ar} يتطلب صورة أو فيديو.`);
  if (platform === "TIKTOK" || platform === "YOUTUBE") {
    if (mediaKinds.length && !mediaKinds.includes("video")) out.push(lang === "en" ? `${p.en} needs a video.` : `${p.ar} يحتاج فيديو.`);
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

/**
 * The English of the registry's Arabic notes and requirements (the integrations screen in English).
 * Keyed by the Arabic text exactly as written above; a missing entry falls back to the Arabic.
 */
const PLATFORM_TEXT_EN: Record<string, string> = {
  "نشر نص/رابط/صورة على الصفحة عبر Graph API (/{page-id}/feed و /photos).": "Publishes text, links and images to the Page through the Graph API (/{page-id}/feed and /photos).",
  "Meta Marketing API — قراءة الحملات والإنفاق في المرحلة الثالثة.": "Meta Marketing API — reading campaigns and spend comes in phase 3.",
  "تطبيق Meta للمطورين مرتبط بـ Business Manager": "A Meta developer app linked to Business Manager",
  "صلاحيات pages_manage_posts و pages_read_engagement (تتطلب App Review)": "The pages_manage_posts and pages_read_engagement permissions (App Review required)",
  "Page access token طويل الأمد": "A long-lived Page access token",
  "نشر صورة عبر Content Publishing API (إنشاء حاوية ثم media_publish). القصص والريلز يدوياً في هذا الإصدار.": "Publishes an image through the Content Publishing API (create a container, then media_publish). Stories and Reels are manual in this release.",
  "ضمن Meta Marketing API.": "Part of the Meta Marketing API.",
  "حساب Instagram احترافي مرتبط بصفحة فيسبوك": "A professional Instagram account linked to a Facebook Page",
  "صلاحية instagram_content_publish (App Review)": "The instagram_content_publish permission (App Review)",
  "الصورة برابط عام HTTPS يمكن لـ Meta جلبه": "The image at a public HTTPS URL that Meta can fetch",
  "Content Posting API يتطلب تدقيق التطبيق؛ قبل التدقيق يُنشر المحتوى خاصاً فقط، لذا النشر يدوي حالياً.": "The Content Posting API requires an app audit; before it, content can only be posted privately, so publishing is manual for now.",
  "TikTok Business API (REST مباشر؛ حزمة SDK الرسمية غير مؤكدة المصدر — انظر OSS-VETTING).": "TikTok Business API (direct REST; the official SDK's provenance is unconfirmed — see OSS-VETTING).",
  "حساب TikTok for Business": "A TikTok for Business account",
  "تطبيق مطور مدقَّق لنشر عام": "An audited developer app for public posting",
  "حساب إعلاني ووصول Marketing API": "An ad account and Marketing API access",
  "لا يوجد API عام لنشر القصص العضوية للحسابات العامة؛ النشر يدوي.": "There is no public API for posting organic Stories from public accounts; publishing is manual.",
  "Snapchat Marketing API (OAuth2، REST).": "Snapchat Marketing API (OAuth2, REST).",
  "Snapchat Business Manager": "Snapchat Business Manager",
  "تطبيق OAuth معتمد للـ Marketing API": "An approved OAuth app for the Marketing API",
  "نشر التغريدات عبر X API v2 يتطلب باقة مدفوعة؛ يدوي حتى يُعتمد الاشتراك.": "Posting through X API v2 needs a paid plan; manual until the subscription is approved.",
  "X Ads API يتطلب موافقة منفصلة.": "The X Ads API needs a separate approval.",
  "اشتراك X API (Basic أو أعلى) للكتابة": "An X API subscription (Basic or higher) to write",
  "موافقة X Ads API للإعلانات": "X Ads API approval for ads",
  "رفع الفيديو عبر YouTube Data API يحتاج OAuth وحصة يومية؛ يدوي في هذا الإصدار.": "Uploading video through the YouTube Data API needs OAuth and a daily quota; manual in this release.",
  "إعلانات يوتيوب عبر Google Ads API.": "YouTube ads through the Google Ads API.",
  "مشروع Google Cloud مع YouTube Data API v3": "A Google Cloud project with YouTube Data API v3",
  "شاشة موافقة OAuth موثّقة": "A verified OAuth consent screen",
  "Posts API لصفحات الشركات يتطلب Community Management API المعتمد.": "The Posts API for company pages needs an approved Community Management API.",
  "صفحة شركة": "A company page",
  "اعتماد LinkedIn Community Management API": "LinkedIn Community Management API approval",
  "Pinterest API v5 يتيح إنشاء الدبابيس بعد اعتماد التطبيق؛ يدوي حالياً.": "Pinterest API v5 allows creating Pins once the app is approved; manual for now.",
  "حساب Pinterest للأعمال": "A Pinterest business account",
  "تطبيق Pinterest معتمد بصلاحية pins:write": "An approved Pinterest app with the pins:write scope",
  "منشورات الملف التجاري عبر Business Profile APIs تتطلب طلب وصول من Google.": "Business Profile posts through the Business Profile APIs need an access request to Google.",
  "ملف تجاري موثّق": "A verified Business Profile",
  "الموافقة على Business Profile APIs": "Approval for the Business Profile APIs",
  "قراءة الحملات والإنفاق والنتائج (ads_read)، ثم التعديل (ads_management) بموافقة.": "Reads campaigns, spend and results (ads_read), then edits them (ads_management) with an approval.",
  "حساب إعلاني في Business Manager": "An ad account in Business Manager",
  "Marketing API: ads_read ثم ads_management (App Review)": "Marketing API: ads_read, then ads_management (App Review)",
  "TikTok Business API — التقارير ثم إدارة الحملات.": "TikTok Business API — reports, then campaign management.",
  "TikTok Ads Manager": "TikTok Ads Manager",
  "وصول Marketing API للتطبيق": "Marketing API access for the app",
  "Snapchat Marketing API — الإحصاءات ثم الإدارة.": "Snapchat Marketing API — statistics, then management.",
  "حساب إعلاني": "An ad account",
  "تطبيق OAuth": "An OAuth app",
  "Google Ads API عبر REST الرسمي (لا مكتبة Node رسمية؛ انظر OSS-VETTING).": "Google Ads API through the official REST interface (no official Node library; see OSS-VETTING).",
  "حساب Google Ads (MCC يُفضّل)": "A Google Ads account (an MCC is preferred)",
  "Developer token بوصول Basic على الأقل": "A developer token with at least Basic access",
  "OAuth": "OAuth",
  "يتطلب موافقة X Ads API.": "Needs X Ads API approval.",
  "موافقة X Ads API": "X Ads API approval",
  "خاصية GA4": "A GA4 property",
  "حساب خدمة بصلاحية قراءة على الخاصية": "A service account with read access to the property",
  "Analytics Data API مفعّل": "The Analytics Data API enabled",
  "حاوية GTM": "A GTM container",
  "صلاحية قراءة؛ أي نشر لإصدار جديد يمر بموافقة واختبار (لا ينشر النظام تلقائياً)": "Read access; publishing any new version goes through approval and testing (the system never publishes on its own)",
  "موقع موثّق في Search Console": "A verified site in Search Console",
  "حساب خدمة مضاف كمستخدم": "A service account added as a user",
  "حساب WhatsApp Business على Meta Cloud API (رقم مخصص وموثّق)": "A WhatsApp Business account on the Meta Cloud API (a dedicated, verified number)",
  "قوالب رسائل معتمدة من Meta لكل رسالة تبدأها الشركة": "Meta-approved message templates for every message the company starts",
  "موافقة صريحة من العميل على الرسائل التسويقية، وخيار إلغاء الاشتراك": "Explicit customer consent to marketing messages, and an opt-out",
  "تُحتسب تكلفة لكل رسالة حسب الفئة والدولة (تسعير Meta)": "Each message is charged by category and country (Meta pricing)",
  "كرزون شريك رسمي لـ Meta (WhatsApp Solution Partner) ويرسل عبر Cloud API — ليس واجهة غير رسمية": "Karzoun is an official Meta partner (WhatsApp Solution Partner) and sends through the Cloud API — not an unofficial interface",
  "مفتاح API من نوع «مساحة العمل» (Developer › API keys) بأقل صلاحيات لازمة، ومعرّف تكامل الواتساب": "A workspace API key (Developer › API keys) with the least permissions needed, and the WhatsApp integration ID",
  "القوالب تُنشأ وتُعتمد في كرزون/WhatsApp Manager ثم «مزامنة» هنا": "Templates are created and approved in Karzoun / WhatsApp Manager, then “synced” here",
  "Webhook من كرزون (core:customer.update) لمزامنة إلغاء الاشتراك، موقّع بـ X-Karzoun-Signature-256": "A Karzoun webhook (core:customer.update) to sync opt-outs, signed with X-Karzoun-Signature-256",
  "إذا كانت أتمتة السلة المتروكة مفعّلة داخل كرزون نفسه فأوقف إحداهما حتى لا يصل العميل تذكيران": "If abandoned-cart automation is also on inside Karzoun, turn one of them off so the customer does not get two reminders",
  "مستقبل Webhooks موقّع (HMAC) بصيغة موحّدة «Hiqbah Store Webhook v1» + استيراد CSV معلن كإدخال يدوي": "A signed (HMAC) webhook receiver in one format, “Hiqbah Store Webhook v1”, plus a CSV import declared as manual entry",
  "ربط سلة المباشر يُبنى ضمن مسار ربط سلة في النظام ويغذي الصيغة نفسها": "The direct Salla connection is built in the system's Salla integration track and feeds the same format",
  "مفتاح Anthropic API على الخادم فقط": "An Anthropic API key on the server only",
  "تكلفة حسب الاستخدام": "Pay-as-you-go cost",
  "كل مخرجات الاستوديو مسودات تمر بالموافقة": "Everything the studio produces is a draft that goes through approval",
};

/** A registry note or requirement in the viewer's language (the Arabic when no English is known). */
export function platformText(ar: string, lang: "ar" | "en"): string {
  return lang === "en" ? (PLATFORM_TEXT_EN[ar] ?? ar) : ar;
}

/** The size guide's format names in English. */
export const ASPECT_FORMAT_EN: Record<string, string> = {
  "منشور": "Post", "قصة / ريلز": "Story / Reel", "فيديو": "Video", "قصة / إعلان": "Story / ad", "صورة": "Image", "فيديو / Shorts": "Video / Shorts", "دبوس": "Pin",
};
