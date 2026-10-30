"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Ico } from "./icons";
import { customerActionHref, type CreateAction } from "./creates";
import { readRecent, rememberRecent, type RecentRecord } from "./recent";
import { foldArabic } from "@/lib/services/search/normalize";
import "./quick-jump.css";

/**
 * Ctrl K (batch 24 WP-A): «ابحث عن عميل أو صفقة أو عرض…». It finds RECORDS — customers (name, phone, city),
 * deals, quotations (number or customer), leads — through GET /api/search (the scope is the server's), and
 * the pages, as before (reference `palette-1440`). With nothing typed it lists «فتحتها مؤخرًا» (this
 * device's last 8 records) and then every page. When a customer row is highlighted, its quick actions
 * follow it: سجّل نشاط, عرض سعر, طلب عيّنة — each chip reads «Alt+N / Alt+Q / Alt+S» (the letter alone types into the
 * search), or Enter on the action. No keyboard hints on a touch screen or a phone (council fix round 2, item 6).
 *
 * The same component is «لأي عميل؟» for the «+ جديد» items done on a customer (`pick`): customers only.
 * Typing is debounced (150 ms); Arabic is folded on both sides (أ/إ/آ→ا, ة→ه, ى→ي, no tatweel/harakat).
 */
export type PalPage = { id: string; href: string; text: string; context: string | null; group: string | null; groupLabel: string | null; icon: ReactNode };
type Hit = { kind: "customer" | "deal" | "quote" | "lead"; id: string; title: string; titleEn: string; sub: string | null; href: string; customerId: string | null; phone?: string | null; status: string | null; tier?: "VIP" | "REGULAR" | "SMALL" | "QUIET" | null };
/** The derived tier (WP-B «يومي»), the same words «يومي» uses. */
const TIER_WORD: Record<"VIP" | "REGULAR" | "SMALL" | "QUIET", [string, string]> = { VIP: ["VIP", "VIP"], REGULAR: ["عادي", "Regular"], SMALL: ["صغير", "Small"], QUIET: ["بدون طلبات حديثة", "No recent orders"] };
type Found = { customers: Hit[]; deals: Hit[]; quotes: Hit[]; leads: Hit[] };
type Row =
  | { t: "rec"; key: string; group: string; label: string; title: string; sub: string | null; href: string; rec: RecentRecord; customerId: string | null }
  | { t: "hit"; key: string; group: string; label: string; hit: Hit }
  | { t: "act"; key: string; group: string; label: string; action: CreateAction; customerId: string; customerName: string }
  | { t: "page"; key: string; group: string; label: string | null; page: PalPage };

const KIND_ICON: Record<Hit["kind"], ReactNode> = {
  customer: <Ico name="users" />, deal: <Ico name="deal" />, quote: <Ico name="quote" />, lead: <Ico name="users" />,
};

/** Focus trap shared by the shell's overlays: Tab cycles inside, Escape closes. */
export function useTrap(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const el = ref.current;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const f = Array.from(el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input,[tabindex]:not([tabindex="-1"])'));
      if (f.length === 0) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  return ref;
}

export function QuickJump({ lang, userId, pages, actions, pick, onClose }: {
  lang: string; userId: string; pages: PalPage[];
  /** The permitted on-customer actions (N, Q, S) offered under a highlighted customer. */
  actions: CreateAction[];
  /** «لأي عميل؟»: pick a customer, then do this. */
  pick?: CreateAction | null;
  onClose: () => void;
}) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const router = useRouter();
  const ref = useTrap(onClose);
  const [q, setQ] = useState("");
  // The highlighted row by its key, so it stays put when the quick actions move.
  const [selKey, setSelKey] = useState<string | null>(null);
  const [found, setFound] = useState<{ q: string; data: Found } | null>(null);
  const [failed, setFailed] = useState(false);
  const [recent] = useState<RecentRecord[]>(() => readRecent(userId));
  const query = q.trim();

  // Records: debounced 150 ms; the newest answer wins.
  useEffect(() => {
    if (foldArabic(query).length < 2) return;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=${pick ? 8 : 5}`, { signal: ctl.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: Found) => { setFound({ q: query, data: d }); setFailed(false); })
        .catch((e: Error) => { if (e.name !== "AbortError") setFailed(true); });
    }, 150);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [query, pick]);
  const searching = foldArabic(query).length >= 2 && found?.q !== query && !failed;
  const data = foldArabic(query).length >= 2 && found ? found.data : null;

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const recentLabel = L("فتحتها مؤخرًا", "Recently opened");
    if (!query) {
      for (const r of recent) {
        if (pick && r.kind !== "customer") continue;
        out.push({ t: "rec", key: `rec-${r.kind}-${r.id}`, group: "recent", label: recentLabel, title: ar ? r.title : r.titleEn || r.title, sub: r.sub ?? null, href: r.href, rec: r, customerId: r.kind === "customer" ? r.id : null });
      }
    }
    if (data) {
      const groups: [keyof Found, string][] = pick ? [["customers", L("العملاء", "Customers")]] : [
        ["customers", L("العملاء", "Customers")], ["deals", L("الصفقات", "Deals")], ["quotes", L("عروض الأسعار", "Quotations")], ["leads", L("العملاء المحتملون", "Leads")],
      ];
      for (const [k, label] of groups) for (const h of data[k] ?? []) out.push({ t: "hit", key: `${h.kind}-${h.id}`, group: k, label, hit: h });
    }
    if (!pick) {
      const f = foldArabic(query);
      const hit = (s: string | null) => !!s && foldArabic(s).includes(f);
      for (const p of query ? pages.filter((d) => hit(d.text) || hit(d.context) || hit(d.groupLabel)) : pages) {
        out.push({ t: "page", key: `page-${p.id}`, group: `page-${p.group ?? "top"}`, label: query ? L("الصفحات", "Pages") : p.groupLabel, page: p });
      }
    }
    return out;
  }, [query, data, recent, pages, pick, ar]); // eslint-disable-line react-hooks/exhaustive-deps -- L is a pure function of `ar`

  // The quick actions follow the highlighted customer (or the action under it that is highlighted).
  const [anchor, setAnchor] = useState<{ id: string; name: string } | null>(null);
  const shownActions = useMemo(() => (pick ? [] : actions), [pick, actions]);
  const full: Row[] = useMemo(() => {
    if (!anchor || !shownActions.length) return rows;
    const at = rows.findIndex((r) => (r.t === "hit" && r.hit.kind === "customer" && r.hit.id === anchor.id) || (r.t === "rec" && r.customerId === anchor.id));
    if (at < 0) return rows;
    const label = ar ? `إجراء سريع على «${anchor.name}»` : `Quick action on “${anchor.name}”`;
    const acts: Row[] = shownActions.map((a) => ({ t: "act", key: `act-${a.id}`, group: `act-${anchor.id}`, label, action: a, customerId: anchor.id, customerName: anchor.name }));
    return [...rows.slice(0, at + 1), ...acts, ...rows.slice(at + 1)];
  }, [rows, anchor, shownActions, ar]);
  const cur = Math.max(0, selKey ? full.findIndex((r) => r.key === selKey) : 0);
  const curRow = full[cur];
  // Re-anchor when the highlight lands on a customer; keep it while on that customer's actions.
  const curCustomer = curRow?.t === "hit" && curRow.hit.kind === "customer" ? { id: curRow.hit.id, name: curRow.hit.title }
    : curRow?.t === "rec" && curRow.customerId ? { id: curRow.customerId, name: curRow.title } : null;
  if (curCustomer && (anchor?.id !== curCustomer.id)) setAnchor(curCustomer);
  else if (!curCustomer && curRow?.t !== "act" && anchor) setAnchor(null);

  const remember = (r: Row) => {
    if (r.t === "hit") rememberRecent(userId, { kind: r.hit.kind, id: r.hit.id, title: r.hit.title, titleEn: r.hit.titleEn, sub: r.hit.sub, href: r.hit.href });
    if (r.t === "rec") rememberRecent(userId, r.rec);
  };
  const go = (r: Row | undefined) => {
    if (!r) return;
    remember(r);
    const customerId = r.t === "hit" ? r.hit.customerId : r.t === "rec" ? r.customerId : r.t === "act" ? r.customerId : null;
    if (pick) { if (customerId) router.push(customerActionHref(pick, customerId)); }
    else if (r.t === "act") router.push(customerActionHref(r.action, r.customerId));
    else router.push(r.t === "hit" ? r.hit.href : r.t === "rec" ? r.href : r.page.href);
    onClose();
  };
  const quick = (key: string) => {
    if (!anchor) return false;
    const a = shownActions.find((x) => x.key === key);
    if (!a) return false;
    router.push(customerActionHref(a, anchor.id));
    onClose();
    return true;
  };

  // Blocks: a heading wherever the group changes (the page groups keep their `palgroup-*` test ids).
  const blocks: { key: string; label: string | null; items: { r: Row; i: number }[] }[] = [];
  full.forEach((r, i) => {
    const last = blocks[blocks.length - 1];
    if (last && last.key === r.group) last.items.push({ r, i });
    else blocks.push({ key: r.group, label: r.label, items: [{ r, i }] });
  });
  const statusWord = (h: Hit): string | null => {
    if (h.kind === "deal") return h.status === "WON" ? L("مكسوبة", "Won") : h.status === "LOST" ? L("خاسرة", "Lost") : null;
    if (h.kind === "lead") return h.status === "CONVERTED" ? L("صار عميل", "Converted") : null;
    if (h.kind === "quote") return ({ DRAFT: L("مسودة", "Draft"), ISSUED: L("مُرسل", "Issued"), ACCEPTED: L("مقبول", "Accepted"), REJECTED: L("مرفوض", "Rejected"), EXPIRED: L("منتهي", "Expired") } as Record<string, string>)[h.status ?? ""] ?? null;
    return null;
  };
  const title = pick ? (ar ? `${pick.labelAr}: لأي عميل؟` : `${pick.labelEn}: for which customer?`) : L("بحث أو انتقال", "Search or jump");
  const placeholder = pick ? L("اكتب اسم العميل أو جواله…", "Type the customer's name or phone…") : L("ابحث عن عميل أو صفقة أو عرض…", "Search a customer, deal or quotation…");
  const emptyText = pick
    ? (query ? L("ما لقينا عميل بهذا الاسم ضمن عملائك.", "No customer of yours by that name.") : L("اكتب اسم العميل أو رقم جواله.", "Type the customer's name or phone number."))
    : L("ما لقينا شي بهذا الاسم ضمن صلاحياتك. جرّب جزء من الاسم أو رقم الجوال.", "Nothing by that name in your access. Try part of the name or the phone number.");

  return (
    <>
      <div className="d21-scrim" onClick={onClose} />
      <div ref={ref} className="d21-pal" role="dialog" aria-modal="true" aria-label={title} data-testid={pick ? "customer-picker" : "quick-jump"}>
        {pick ? <div className="d21-pal-title">{title}</div> : null}
        <div className="d21-pal-in">
          <Ico name="search" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="d21-pal-list"
            aria-activedescendant={curRow ? `d21-pal-${curRow.key}` : undefined}
            aria-label={placeholder}
            placeholder={placeholder}
            value={q}
            data-testid="quick-jump-input"
            onChange={(e) => { setQ(e.target.value); setSelKey(null); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); const r = full[Math.min(cur + 1, full.length - 1)]; if (r) setSelKey(r.key); }
              else if (e.key === "ArrowUp") { e.preventDefault(); const r = full[Math.max(cur - 1, 0)]; if (r) setSelKey(r.key); }
              else if (e.key === "Enter") { e.preventDefault(); go(full[cur]); }
              else if (e.altKey && /^Key[NQS]$/.test(e.code) && quick(e.code.slice(3))) e.preventDefault();
            }}
          />
          {searching ? <span className="d21-pal-busy" role="status" aria-label={L("جارٍ البحث…", "Searching…")} /> : null}
          <span className="d21-kbd" aria-hidden>Esc</span>
        </div>
        {failed ? <p className="empty" role="alert">{L("تعذّر البحث الآن. حاول مرة ثانية.", "Search failed. Try again.")}</p> : null}
        {full.length === 0 && !searching ? <p className="empty" role="status" data-testid="quick-jump-empty">{emptyText}</p> : (
          <div id="d21-pal-list" role="listbox" aria-label={title} className="d21-pal-list">
            {blocks.map((b, bi) => (
              <ul key={`${b.key}-${bi}`} role="group" aria-label={b.label ?? L("عام", "General")} data-testid={b.key.startsWith("page-") ? `palgroup-${b.key.slice(5)}` : `palgroup-${b.key}`}>
                {b.label ? <li role="presentation" className="d21-pal-grp" aria-hidden>{b.label}</li> : null}
                {b.items.map(({ r, i }) => {
                  const active = i === cur;
                  const common = { tabIndex: -1, "data-active": active, onMouseEnter: () => setSelKey(r.key) };
                  if (r.t === "page") return (
                    <li key={r.key} role="option" id={`d21-pal-${r.key}`} aria-selected={active}>
                      <a href={r.page.href} {...common} onClick={(e) => { e.preventDefault(); go(r); }}>
                        {r.page.icon}<span><b>{r.page.text}</b>{r.page.context ? <small>{r.page.context}</small> : null}</span>
                      </a>
                    </li>
                  );
                  if (r.t === "act") return (
                    <li key={r.key} role="option" id={`d21-pal-${r.key}`} aria-selected={active} className="d21-pal-act">
                      <a href={customerActionHref(r.action, r.customerId)} {...common} data-testid={`pal-${r.action.id}`} onClick={(e) => { e.preventDefault(); go(r); }}>
                        <Ico name={r.action.onCustomer === "quote" ? "quote" : r.action.onCustomer === "sample" ? "flask" : "note"} />
                        <span><b>{r.action.onCustomer === "activity" ? L("سجّل نشاط", "Log activity") : r.action.onCustomer === "quote" ? L("عرض سعر جديد", "New quotation") : L("طلب عيّنة", "Sample request")}</b></span>
                        {/* One convention (council fix round 2, item 6): inside the search the letter needs Alt — the chip says so. */}
                        {r.action.key ? <span className="d21-kbd" aria-hidden data-testid={`pal-key-${r.action.key}`}>Alt+{r.action.key}</span> : null}
                      </a>
                    </li>
                  );
                  const h = r.t === "hit" ? r.hit : null;
                  const word = h ? statusWord(h) : null;
                  const icon = h ? KIND_ICON[h.kind] : KIND_ICON[r.t === "rec" ? r.rec.kind : "customer"];
                  const name = h ? (ar ? h.title : h.titleEn || h.title) : r.t === "rec" ? r.title : "";
                  const sub = h ? h.sub : r.t === "rec" ? r.sub : null;
                  const href = h ? h.href : r.t === "rec" ? r.href : "#";
                  return (
                    <li key={r.key} role="option" id={`d21-pal-${r.key}`} aria-selected={active}>
                      <a href={href} {...common} data-testid={h ? `pal-hit-${h.kind}-${h.id}` : `pal-recent-${r.key}`} onClick={(e) => { e.preventDefault(); go(r); }}>
                        {icon}
                        <span><b><bdi>{name}</bdi>{h?.tier ? <em className={`d21-pal-st d21-pal-tier is-${h.tier.toLowerCase()}`} data-testid={`pal-tier-${h.id}`}>{TIER_WORD[h.tier][ar ? 0 : 1]}</em> : null}{word ? <em className="d21-pal-st">{word}</em> : null}</b>{sub || h?.phone ? <small>{sub ? <bdi>{sub}</bdi> : null}{sub && h?.phone ? " · " : null}{h?.phone ? <bdi dir="ltr">{h.phone}</bdi> : null}</small> : null}</span>
                        {active ? <small className="d21-pal-hint" aria-hidden>{pick ? L("Enter يختار", "Enter picks") : L("Enter يفتح", "Enter opens")}</small> : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            ))}
          </div>
        )}
        <div className="d21-pal-foot" aria-hidden>
          <span>↑↓ {L("للتنقل", "to move")}</span><span>Enter {pick ? L("للاختيار", "to pick") : L("للفتح", "to open")}</span><span>Esc {L("للإغلاق", "to close")}</span>
          {!pick ? <span>? {L("كل الاختصارات", "all shortcuts")}</span> : null}
        </div>
      </div>
    </>
  );
}

/** «?» — the keyboard cheat-sheet. */
export function ShortcutsSheet({ lang, creates, onClose }: { lang: string; creates: CreateAction[]; onClose: () => void }) {
  const ar = lang === "ar";
  const L = (a: string, e: string) => (ar ? a : e);
  const ref = useTrap(onClose);
  const rows: [string, string][] = [
    ["Ctrl K", L("ابحث عن عميل أو صفقة أو عرض، أو انتقل لصفحة", "Search a customer, deal or quotation, or jump to a page")],
    ...creates.filter((c) => c.key).map((c) => [c.key!, ar ? c.labelAr : c.labelEn] as [string, string]),
    ["?", L("هذه القائمة", "This list")],
    ["Esc", L("إغلاق", "Close")],
  ];
  return (
    <>
      <div className="d21-scrim" onClick={onClose} />
      <div ref={ref} className="d21-pal d21-keys" role="dialog" aria-modal="true" aria-labelledby="d21-keys-h" data-testid="shortcuts-sheet">
        <div className="d21-pal-title" id="d21-keys-h">{L("اختصارات لوحة المفاتيح", "Keyboard shortcuts")}</div>
        <p className="d21-keys-note">{L("تشتغل من أي صفحة، إذا ما كنت تكتب في خانة.", "They work on any page while you are not typing in a field.")}</p>
        <dl className="d21-keys-list">
          {rows.map(([k, t]) => <div key={k}><dt><span className="d21-kbd">{k}</span></dt><dd>{t}</dd></div>)}
        </dl>
        <div className="d21-pal-foot"><button type="button" className="d21-btn sm" onClick={onClose} autoFocus>{L("تمام", "Got it")}</button></div>
      </div>
    </>
  );
}
