// The text a platform receives for a post variant. Pure: the publisher sends it and the editor's
// preview shows it, so what is previewed is what goes out.
export function composeCaption(caption: string, hashtags: string[], link: string | null, cta: string | null): string {
  const tags = hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ");
  return [caption.trim(), cta?.trim(), link && !caption.includes(link) ? link : null, tags].filter(Boolean).join("\n\n");
}
