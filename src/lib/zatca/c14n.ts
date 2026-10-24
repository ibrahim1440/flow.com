// ZATCA Phase 2 (A4) — the invoice hash: canonical XML 1.1 (http://www.w3.org/2006/12/xml-c14n11) of the document
// with three subtrees removed, SHA-256, base64 (XML Implementation Standard §"invoice hash"; Security Features
// Implementation Standard §"hashing"). Matches the official SDK (zatca-einvoicing-sdk 238-R3.2.7,
// HashingGenerationServiceImpl): an XSLT drops //Invoice//UBLExtensions, //Invoice//Signature and the
// AdditionalDocumentReference whose cbc:ID is "QR" — every whitespace text node around them stays — then Apache
// Santuario canonicalizes the whole result with C14N 1.1 (without comments). The unit suite checks this against the
// SDK's own hash of its sample invoices.
//
// C14N 1.1 of a WHOLE document (not a subset) differs from C14N 1.0 only in xml:* attribute inheritance into a
// subset, which never arises here. Rules applied: no XML declaration, no DOCTYPE, comments dropped, CDATA as text,
// "\r\n" → "\n", empty elements as start + end tags, namespace declarations first (sorted by prefix, default
// first), then attributes sorted by (namespace URI, local name), superfluous re-declarations omitted, the C14N
// escaping of text (& < > CR) and attribute values (& < " TAB LF CR).
import { createHash } from "node:crypto";
import { DOMParser, type Document as XDocument, type Element as XElement, type Node as XNode } from "@xmldom/xmldom";

const XMLNS = "http://www.w3.org/2000/xmlns/";
const CBC = "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2";

/** Parse strictly: any well-formedness error throws (never a silently repaired document). */
export function parseXml(xml: string): XDocument {
  const errors: string[] = [];
  let doc: XDocument;
  try {
    doc = new DOMParser({
      onError: (level, msg) => { if (level !== "warning") errors.push(String(msg)); },
    }).parseFromString(xml.replace(/\r\n?/g, "\n"), "text/xml");
  } catch (e) {
    throw new Error(`XML not well-formed: ${(e as Error).message}`);
  }
  if (errors.length || !doc || !doc.documentElement) throw new Error(`XML not well-formed: ${errors[0] ?? "no document element"}`);
  return doc;
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/\t/g, "&#x9;").replace(/\n/g, "&#xA;").replace(/\r/g, "&#xD;");

type NsMap = Map<string, string>; // prefix ("" = default) → URI, as rendered by the output ancestors

function canonElement(el: XElement, rendered: NsMap, out: string[]): void {
  const nsDecls: [string, string][] = [];
  const attrs: { uri: string; local: string; name: string; value: string }[] = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes.item(i)!;
    if (a.namespaceURI === XMLNS || a.name === "xmlns" || a.name.startsWith("xmlns:")) {
      const prefix = a.name === "xmlns" ? "" : a.name.slice(6);
      nsDecls.push([prefix, a.value]);
    } else {
      attrs.push({ uri: a.namespaceURI ?? "", local: a.localName ?? a.name, name: a.name, value: a.value });
    }
  }
  const mine: NsMap = new Map(rendered);
  const emit: [string, string][] = [];
  for (const [prefix, uri] of nsDecls) {
    const current = rendered.get(prefix);
    if (prefix === "" && uri === "" && (current === undefined || current === "")) continue; // xmlns="" with no default in scope
    if (current === uri) continue; // superfluous
    emit.push([prefix, uri]);
    mine.set(prefix, uri);
  }
  emit.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  attrs.sort((a, b) => (a.uri !== b.uri ? (a.uri < b.uri ? -1 : 1) : a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
  out.push("<", el.tagName);
  for (const [prefix, uri] of emit) out.push(prefix ? ` xmlns:${prefix}="${escAttr(uri)}"` : ` xmlns="${escAttr(uri)}"`);
  for (const a of attrs) out.push(` ${a.name}="${escAttr(a.value)}"`);
  out.push(">");
  for (let c = el.firstChild; c; c = c.nextSibling) canonNode(c, mine, out);
  out.push("</", el.tagName, ">");
}

function canonNode(n: XNode, rendered: NsMap, out: string[]): void {
  switch (n.nodeType) {
    case 1: canonElement(n as XElement, rendered, out); break;
    case 3: case 4: out.push(escText(n.nodeValue ?? "")); break; // text, CDATA
    case 7: out.push(`<?${(n as unknown as { target: string }).target}${n.nodeValue ? ` ${n.nodeValue}` : ""}?>`); break;
    default: break; // comments (C14N without comments), others
  }
}

/** C14N 1.1 (without comments) of a whole document. */
export function canonicalize(doc: XDocument): string {
  const out: string[] = [];
  canonElement(doc.documentElement!, new Map(), out);
  return out.join("");
}

function childText(el: XElement, ns: string, local: string): string | null {
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1 && (c as XElement).localName === local && (c as XElement).namespaceURI === ns) return (c as XElement).textContent ?? "";
  }
  return null;
}

/** Remove what the invoice hash excludes (the SDK's invoice.xsl): UBLExtensions, Signature, the QR reference. */
export function stripForHash(doc: XDocument): XDocument {
  const doomed: XNode[] = [];
  const walk = (el: XElement, depth: number) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const e = c as XElement;
      const local = e.localName;
      if (depth >= 0 && (local === "UBLExtensions" || local === "Signature" || (local === "AdditionalDocumentReference" && (childText(e, CBC, "ID") ?? "").trim() === "QR"))) {
        doomed.push(e);
        continue;
      }
      walk(e, depth + 1);
    }
  };
  walk(doc.documentElement!, 0);
  for (const d of doomed) d.parentNode!.removeChild(d);
  return doc;
}

/** The canonical bytes the invoice hash is taken over (exposed for tests and the support view). */
export function hashInput(xml: string): string {
  return canonicalize(stripForHash(parseXml(xml)));
}

/** base64(SHA-256(C14N11(invoice minus UBLExtensions / Signature / QR))) — the ZATCA invoice hash. */
export function invoiceHash(xml: string): string {
  return createHash("sha256").update(hashInput(xml), "utf8").digest("base64");
}

/** The raw 32 bytes of the invoice hash (what the ECDSA signature is computed over, SHA256withECDSA). */
export function invoiceHashBytes(xml: string): Buffer {
  return createHash("sha256").update(hashInput(xml), "utf8").digest();
}

/** Text of the first element matching a namespace + local name path from the root (no XPath engine). */
export function textAt(xml: string, path: [ns: string, local: string][]): string | null {
  let el: XElement | null = parseXml(xml).documentElement!;
  for (const [ns, local] of path) {
    let next: XElement | null = null;
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && (c as XElement).localName === local && (c as XElement).namespaceURI === ns) { next = c as XElement; break; }
    }
    if (!next) return null;
    el = next;
  }
  return el.textContent;
}
