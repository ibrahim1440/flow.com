import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { text, target } = await request.json();

  if (!text?.trim()) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
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
    return NextResponse.json({ error: json.responseDetails ?? "Translation failed" }, { status: 502 });
  }

  const translated: string = json.responseData?.translatedText ?? "";
  return NextResponse.json({ translated });
}
