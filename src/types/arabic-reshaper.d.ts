declare module 'arabic-reshaper' {
  export function convertArabic(text: string): string;
}

declare module 'bidi-js' {
  interface BidiEngine {
    getEmbeddingLevels(text: string): unknown;
    getReorderedString(text: string, embeddingLevels: unknown): string;
  }
  function bidiFactory(): BidiEngine;
  export default bidiFactory;
}
