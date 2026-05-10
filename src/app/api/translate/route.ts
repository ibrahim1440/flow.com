import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const { text, target } = await request.json();

  if (!text?.trim()) {
    return NextResponse.json({ error: "No text provided" }, { status: 400 });
  }

  const apiKey = process.env.TRANSLATION_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Translation service not configured. Add TRANSLATION_API_KEY to your environment variables." },
      { status: 503 }
    );
  }

  const lang = target ?? "ar";

  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target: lang, source: "en", format: "text" }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    return NextResponse.json({ error: `Translation API error: ${body}` }, { status: 502 });
  }

  const json = await res.json();
  const translated: string = json.data?.translations?.[0]?.translatedText ?? "";

  return NextResponse.json({ translated });
}
