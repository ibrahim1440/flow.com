"use client";

import type { ReactNode } from "react";
import { LanguageProvider } from "@/lib/i18n/context";
import "@/components/shell/direction-2.1.css";
import "@/components/hr/hr.css";
import { BrandMark } from "@/components/brand/BrandMark";
import "./guest.css";

export type GuestLang = "ar" | "en";
export type GuestStep = "name" | "cups" | "done";

/**
 * The guest page frame (GX-G G-08, Figma 1228:5609 / 1228:103453 / 1228:107763): brand row,
 * «لا يلزم تسجيل الدخول», the session title with the three steps, one white card, the footnote.
 * A standalone Direction 2.1 surface: the `.d21` root carries the tokens, `data-hr-root` the
 * shared button / dot / notice styles. No session, no shell, no data of its own.
 */
export function GuestShell({ lang, onLang, title, step, foot, children, kicker, headSub, testId = "guest-cupping-root" }: {
  lang: GuestLang;
  onLang: (l: GuestLang) => void;
  title?: string | null;
  step?: GuestStep | null;
  foot?: boolean;
  children: ReactNode;
  /** The brand row's second line; cupping's «تذوق SCA · رابط ضيف» unless given (guest QC). */
  kicker?: ReactNode;
  /** The line under the title; cupping's «حِقبة · تذوق SCA» unless given (guest QC). */
  headSub?: ReactNode;
  testId?: string;
}) {
  const L = (ar: string, en: string) => (lang === "ar" ? ar : en);
  const order: GuestStep[] = ["name", "cups", "done"];
  const at = step ? order.indexOf(step) : -1;
  const stepLabel: Record<GuestStep, string> = { name: L("الاسم", "Name"), cups: L("الأكواب", "Cups"), done: L("اكتمل", "Done") };
  return (
    <LanguageProvider lang={lang}>
      <div className="d21 gc" lang={lang} dir={lang === "ar" ? "rtl" : "ltr"} data-hr-root="" data-testid={testId}>
        {/* IBM Plex, self-hosted (public/fonts); no third-party font host. */}
        <link rel="stylesheet" precedence="default" href="/fonts/ibm-plex.css" />
        <header className="gc-top">
          <div className="gc-brand">
            <span className="gc-mark" aria-hidden="true"><BrandMark /></span>
            <div>
              <b>{L("حِقبة", "Hiqbah")}</b>
              <span>{kicker ?? (lang === "ar" ? <>تذوق <span className="cf-num">SCA</span> · رابط ضيف</> : <><span className="cf-num">SCA</span> cupping · guest link</>)}</span>
            </div>
          </div>
          <span className="gc-spacer" />
          <span className="gc-nologin">{L("لا يلزم تسجيل الدخول", "No sign-in needed")}</span>
          <button type="button" className="gc-lang" lang={lang === "ar" ? "en" : "ar"} onClick={() => onLang(lang === "ar" ? "en" : "ar")} data-testid="guest-lang">
            {lang === "ar" ? "English" : "العربية"}
          </button>
        </header>
        <main className="gc-main">
          {title ? (
            <div className="gc-head">
              <div>
                <h1>{title}</h1>
                <p>{headSub ?? (lang === "ar" ? <>حِقبة · تذوق <span className="cf-num">SCA</span></> : <>Hiqbah · <span className="cf-num">SCA</span> cupping</>)}</p>
              </div>
              {step ? (
                <ol className="gc-steps" aria-label={L("الخطوات", "Steps")}>
                  {order.map((s, i) => (
                    <li key={s} className={i < at ? "is-done" : i === at ? "is-current" : undefined} aria-current={i === at ? "step" : undefined}>
                      {stepLabel[s]}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          ) : null}
          <div className="gc-card">{children}</div>
          {foot ? <p className="gc-foot">{L("يُقيَّم كل كوب مرة واحدة ولا يُعدَّل التقييم بعد الإرسال. لا تظهر النتائج للضيوف.", "Each cup is scored once and a score cannot be changed after it is sent. Results are not shown to guests.")}</p> : null}
        </main>
      </div>
    </LanguageProvider>
  );
}
