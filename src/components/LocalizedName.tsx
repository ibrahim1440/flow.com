import { pickLocalizedName, type UiLang } from "@/lib/i18n/localized-name";

// E7: a product or material name from master data, in the interface language, isolated in
// <bdi> with its own direction. An English fallback inside Arabic text is therefore read
// left-to-right without a visible marker. `data-name-source` records which value rendered
// (ar / en / code) for the tests; it is not styled.
export function LocalizedName({
  lang,
  en,
  ar,
  lastResort,
}: {
  lang: UiLang;
  en?: string | null;
  ar?: string | null;
  lastResort?: string;
}) {
  const n = pickLocalizedName(lang, { en, ar }, lastResort);
  return (
    <bdi dir={n.dir} lang={n.source === "ar" ? "ar" : "en"} data-name-source={n.source}>
      {n.text}
    </bdi>
  );
}
