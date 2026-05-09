declare module 'arabic-reshaper' {
  export function convertArabic(text: string): string;
}

declare module 'bidi-js' {
  interface BidiEngine {
    getVisualOrder(text: string): number[];
    getReorderedString(text: string): string;
  }
  function bidiFactory(): BidiEngine;
  export default bidiFactory;
}
