"use client";
// The permission matrix (Figma UR-06 605:3345 role editor, UR-02b 598:550 one user's access; users.py
// m_grp / m_mod / m_act): the owner's groups (P-6), each module's level as a Segmented control
// «لا وصول · عرض · تعديل», its actions as checkboxes under it, «حساس» on the sensitive ones and
// «تغيّر» on every unsaved cell. Rules drawn here and enforced again by the server:
//   · «تعديل» never ticks an action (P-3) — a level change leaves the actions as they were;
//   · a module at «لا وصول» shows no actions (its actions are cleared: they would do nothing);
//   · read-only on a phone (J-8 / O-7) and for a system template (O-3);
//   · for a power user (owner decision 19 Oct): nothing above its own access can be raised, and
//     «مستخدم متقدّم» (employees › manage_access) is the administrator's alone — disabled here,
//     refused by the server (src/lib/users/power.ts).
import { useState } from "react";
import { Ico } from "@/components/shell/icons";
import { GROUPS, isSensitive, moduleLabel, subLabel, subsOf } from "@/lib/users/catalog";
import type { Cells } from "@/lib/users/model";
import { MANAGE_ACCESS_KEY, withinOwn } from "@/lib/users/power";
import { SensFlag, SrcTag, fmtShort, useLangL, type Source } from "./shared";

const LEVELS = ["none", "view", "edit"] as const;

export type MatrixProps = {
  /** The values shown (the editor's working copy). */
  value: Cells;
  /** The values before any unsaved change (for «تغيّر» and «كان: …»). */
  original: Cells;
  /** User mode: the role's template, for each cell's source (role / grant / deny). */
  template?: Cells;
  onChange?: (module: string, sub: string | null, v: string) => void;
  readOnly?: boolean;
  mode: "role" | "user";
  /** User mode: the expiry the new exceptions will carry («ينتهي في …»). */
  expiresAt?: string | null;
  /** User mode: what an existing exception says about a cell (reason, expiry). */
  overrideOf?: (module: string, sub: string | null) => { expiresAt: string | null } | null;
  /** A power user's own cells: no value above them can be set (null / absent = the administrator). */
  limit?: Cells | null;
  testId?: string;
};

const lvlWord = (v: string, ar: boolean) => (ar ? { none: "لا وصول", view: "عرض", edit: "تعديل" } : { none: "No access", view: "View", edit: "Edit" })[v as "none"] ?? v;

export function PermissionMatrix(props: MatrixProps) {
  const { value, original, template, onChange, readOnly, mode, testId, limit } = props;
  // A raise the editor may not make: above a power user's own access, or «مستخدم متقدّم» itself.
  const blocked = (m: string, s: string | null, v: string) => !!limit && ((s !== null && `${m}.${s}` === MANAGE_ACCESS_KEY) || (v !== (s === null ? value[m].access : String(value[m].sub[s] === true)) && !withinOwn(limit, { module: m, sub: s }, v)));
  const { lang, ar, L } = useLangL();
  const changedCell = (m: string, s: string | null) => (s === null ? value[m].access !== original[m].access : value[m].access !== "none" && value[m].sub[s] !== original[m].sub[s]);
  const groupChanged = (mods: string[]) => mods.some((m) => changedCell(m, null) || subsOf(m).some((s) => changedCell(m, s)));
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(GROUPS.map((g) => [g.key, g.modules.some((m) => value[m].access !== "none")])));
  const source = (m: string, s: string | null): Source | null => {
    if (!template) return null;
    const v = s === null ? value[m].access : String(value[m].sub[s] === true);
    const r = s === null ? template[m].access : String(template[m].sub[s] === true);
    if (v === r) return "role";
    if (s === null) return LEVELS.indexOf(v as "none") > LEVELS.indexOf(r as "none") ? "grant" : "deny";
    return v === "true" ? "grant" : "deny";
  };
  const summary = (g: (typeof GROUPS)[number]) => {
    if (mode === "user" && groupChanged(g.modules)) return L("استثناء جديد", "New exception");
    const openMods = g.modules.filter((m) => value[m].access !== "none");
    if (mode === "role") {
      if (open[g.key]) return ar ? (g.modules.length === 1 ? "وحدة واحدة" : g.modules.length === 2 ? "وحدتان" : `${g.modules.length} وحدات`) : `${g.modules.length} modules`;
      return openMods.length ? openMods.map((m) => `${moduleLabel(m, lang)}: ${lvlWord(value[m].access, ar)}`).join(" · ") : lvlWord("none", ar);
    }
    const srcs = g.modules.map((m) => source(m, null));
    const fromRole = srcs.every((x) => x === "role");
    if (!openMods.length) return `${lvlWord("none", ar)} · ${fromRole ? L("من الدور", "from the role") : L("استثناء منع", "deny exception")}`;
    const ex = g.modules.map((m) => props.overrideOf?.(m, null)).find((o) => o?.expiresAt);
    const parts = openMods.map((m) => (g.modules.length > 1 ? `${moduleLabel(m, lang)}: ` : "") + lvlWord(value[m].access, ar));
    return `${parts.join(" · ")} · ${fromRole ? L("من الدور", "from the role") : `${L("استثناء منح", "grant exception")}${ex?.expiresAt ? ` ${L("حتى", "until")} ${fmtShort(ex.expiresAt, lang)}` : ""}`}`;
  };
  const changed = <span className="ur-changed">{L("تغيّر", "Changed")}</span>;
  return (
    <div className="hr-tablewrap">
      <table className="hr-table ur-mx" aria-label={L("مصفوفة الصلاحيات", "Permission matrix")} data-testid={testId ?? "ur-matrix"}>
        <thead>
          <tr><th>{L("الصلاحية", "Permission")}</th><th>{mode === "user" ? L("النتيجة لهذا المستخدم", "Result for this user") : L("المستوى أو السماح", "Level or allowed")}</th><th aria-hidden /></tr>
        </thead>
        <tbody>
          {GROUPS.flatMap((g) => {
            const isOpen = !!open[g.key];
            const rows = [
              <tr key={g.key} className="ur-grp">
                <td colSpan={3}>
                  <button type="button" className="ur-grpbtn" aria-expanded={isOpen} onClick={() => setOpen((o) => ({ ...o, [g.key]: !o[g.key] }))} data-testid={`ur-mx-group-${g.key}`}>
                    <Ico name="chevd" small />{ar ? g.ar : g.en}
                  </button>
                  <span className="ur-grpsum">{summary(g)}</span>
                </td>
              </tr>,
            ];
            if (!isOpen) return rows;
            for (const m of g.modules) {
              const lvl = value[m].access;
              const src = source(m, null);
              const ov = props.overrideOf?.(m, null);
              const modNote = mode === "role"
                ? (changedCell(m, null) ? L(`كان: ${lvlWord(original[m].access, true)}`, `Was: ${lvlWord(original[m].access, false)}`) : "")
                : src && src !== "role" ? L(`الدور: ${lvlWord(template![m].access, true)}${(changedCell(m, null) ? props.expiresAt : ov?.expiresAt) ? ` · ينتهي في ${fmtShort((changedCell(m, null) ? props.expiresAt : ov?.expiresAt)!, "ar")}` : ""}`, `Role: ${lvlWord(template![m].access, false)}`) : "";
              rows.push(
                <tr key={m} data-testid={`ur-mx-${m}`}>
                  <td className="ur-modname">{moduleLabel(m, lang)}{isSensitive(m, null) ? <> <SensFlag lang={lang} /></> : null}{modNote ? <small>{modNote}</small> : null}</td>
                  <td>
                    {readOnly ? <b style={{ fontWeight: 500 }}>{lvlWord(lvl, ar)}</b> : (
                      <span className="tl-seg" role="group" aria-label={moduleLabel(m, lang)}>
                        {LEVELS.map((l) => (
                          <button key={l} type="button" aria-pressed={lvl === l} disabled={lvl !== l && LEVELS.indexOf(l) > LEVELS.indexOf(lvl) && blocked(m, null, l)} title={lvl !== l && LEVELS.indexOf(l) > LEVELS.indexOf(lvl) && blocked(m, null, l) ? L("أعلى من صلاحيتك", "Above your own access") : undefined} onClick={() => onChange?.(m, null, l)} data-testid={`ur-mx-${m}-${l}`}>{lvlWord(l, ar)}</button>
                        ))}
                      </span>
                    )}
                  </td>
                  <td className="ur-end">{changedCell(m, null) ? changed : null}</td>
                </tr>,
              );
              if (lvl === "none") continue;
              for (const s of subsOf(m)) {
                const on = value[m].sub[s] === true;
                const sens = isSensitive(m, s);
                const ssrc = source(m, s);
                const power = `${m}.${s}` === MANAGE_ACCESS_KEY;
                const lockedBox = !!limit && (power || (!on && blocked(m, s, "true")));
                rows.push(
                  <tr key={`${m}.${s}`} className="ur-act" data-testid={`ur-mx-${m}.${s}`}>
                    <td>
                      <span className="ur-actlabel">
                        {readOnly ? null : <input type="checkbox" checked={on} disabled={lockedBox} title={lockedBox ? (power ? L("يمنحها مدير المنشأة فقط", "The administrator's alone") : L("أعلى من صلاحيتك", "Above your own access")) : undefined} onChange={(e) => onChange?.(m, s, String(e.target.checked))} aria-label={subLabel(m, s, lang)} />}
                        <span>{subLabel(m, s, lang)}</span>{sens ? <SensFlag lang={lang} /> : null}
                      </span>
                      {power ? <span className="ur-acthint" data-testid="ur-mx-power-hint">{L("يغيّر أدوار المستخدمين الآخرين وصلاحياتهم واستثناءاتهم ضمن ما يملكه. يمنحها ويزيلها مدير المنشأة فقط.", "Changes other users' roles, permissions and exceptions within its own access. Only the administrator grants or removes it.")}</span> : null}
                    </td>
                    <td className="ur-note">
                      {readOnly ? (on ? L("مسموح", "Allowed") : L("غير مسموح", "Not allowed"))
                        : mode === "user" ? (ssrc && ssrc !== "role" ? <SrcTag source={ssrc} lang={lang} /> : null)
                        : sens && on && changedCell(m, s) ? L("سبب وكلمة المرور عند الحفظ", "Reason and password on save") : null}
                    </td>
                    <td className="ur-end">{changedCell(m, s) ? changed : null}</td>
                  </tr>,
                );
              }
            }
            return rows;
          })}
        </tbody>
      </table>
    </div>
  );
}

export { applyEdit, changedCells } from "@/lib/users/model";
