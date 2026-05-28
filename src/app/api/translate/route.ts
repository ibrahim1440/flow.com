import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth-server";
import { checkAndRecordRateLimit } from "@/lib/api-rate-limit";

export async function POST(request: Request) {
  const { user, error } = await requireAuth();
  if (error) return error;

  const { limited } = await checkAndRecordRateLimit({
    scope: "translate",
    key: user.id,
    limit: 60,
    windowMs: 15 * 60 * 1000,
  });
  if (limited) {
    return NextResponse.json(
      { error: "Too many requests. Try again later." },
      { status: 429 }
    );
  }

  const { text, target } = await request.json();

  if (!text?.trim()) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  if (text.length > 2000) {
    return NextResponse.json(
      { error: "Text is too long. Maximum allowed length is 2000 characters." },
      { status: 400 }
    );
  }

  const lang: string = target === "en" ? "en" : "ar";

  // Try Google Cloud Translation if API key is configured
  const apiKey = process.env.TRANSLATION_API_KEY;
  if (apiKey) {
    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: text, target: lang, source: lang === "ar" ? "en" : "ar", format: "text" }),
      }
    );
    if (res.ok) {
      const json = await res.json();
      const translated: string = json.data?.translations?.[0]?.translatedText ?? "";
      return NextResponse.json({ translated });
    }
  }

  // Fallback: MyMemory free translation API (no key needed, 1000 words/day free)
  const source = lang === "ar" ? "en" : "ar";
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${source}|${lang}`;

  const res = await fetch(url);
  if (!res.ok) {
    return NextResponse.json({ error: "Translation service unavailable" }, { status: 502 });
  }

  const json = await res.json();

  if (json.responseStatus !== 200) {
    return NextResponse.json({ error: "Translation failed" }, { status: 502 });
  }

  const translated: string = json.responseData?.translatedText ?? "";
  return NextResponse.json({ translated });
}
