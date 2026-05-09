"use client";

import { useState, useEffect, useRef } from "react";
import { Tag, Printer, Search } from "lucide-react";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";

type Product = {
  id: string; productNameEn: string; productNameAr: string | null;
  countryEn: string; countryAr: string | null; regionEn: string | null;
  regionAr: string | null; varietyEn: string | null; varietyAr: string | null;
  processEn: string | null; processAr: string | null; altitude: string | null;
  cupNotesEn: string | null; cupNotesAr: string | null;
  roastPathEn: string | null; roastPathAr: string | null;
};

function LabelCard({ product }: { product: Product }) {
  return (
    <div className="border-2 border-orange rounded-xl p-5 bg-white w-[340px] print:break-inside-avoid">
      <div className="text-center mb-3 border-b border-brown-light pb-3">
        <div className="w-12 h-12 bg-orange rounded-full flex items-center justify-center mx-auto mb-2">
          <span className="text-xl text-white font-bold">{"حِ"}</span>
        </div>
        <h3 className="font-extrabold text-charcoal text-lg">{product.productNameEn}</h3>
        {product.productNameAr && <p className="text-brown text-sm" dir="rtl">{product.productNameAr}</p>}
      </div>

      <div className="space-y-1.5 text-xs">
        {[
          { label: "COUNTRY", en: product.countryEn, ar: product.countryAr, labelAr: "الدولة" },
          { label: "REGION", en: product.regionEn, ar: product.regionAr, labelAr: "المنطقة" },
          { label: "VARIETY", en: product.varietyEn, ar: product.varietyAr, labelAr: "السلاله" },
          { label: "PROCESS", en: product.processEn, ar: product.processAr, labelAr: "المعالجة" },
          { label: "ALTITUDE", en: product.altitude, ar: null, labelAr: "الارتفاع" },
          { label: "CUP NOTES", en: product.cupNotesEn, ar: product.cupNotesAr, labelAr: "الايحاءات" },
          { label: "ROAST PATH", en: product.roastPathEn, ar: product.roastPathAr, labelAr: "مسار القهوة" },
        ].map(({ label, en, ar, labelAr }) => (
          <div key={label} className="flex justify-between items-start gap-2 py-1 border-b border-cream last:border-0">
            <div>
              <span className="font-bold text-brown uppercase text-[10px]">{label}</span>
              <p className="text-charcoal">{en || "—"}</p>
            </div>
            <div className="text-right" dir="rtl">
              <span className="font-bold text-brown text-[10px]">{labelAr}</span>
              <p className="text-charcoal">{ar || ""}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="text-center mt-3 pt-2 border-t border-brown-light">
        <p className="text-[10px] text-brown font-medium">HIQBAH COFFEE ROASTERS | {"محمصة حِقبه"}</p>
      </div>
    </div>
  );
}

export default function LabelsPage() {
  const user = useUser();
  const canPrint = hasSubPrivilege(user?.permissions ?? {}, "labels", "print");
  const [products, setProducts] = useState<Product[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const printRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/coffee-products").then((r) => r.json()).then(setProducts);
  }, []);

  function toggleSelect(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  function handlePrint() {
    window.print();
  }

  const filtered = products.filter((p) =>
    `${p.productNameEn} ${p.productNameAr || ""} ${p.countryEn}`.toLowerCase().includes(search.toLowerCase())
  );

  const toPrint = selected.size > 0 ? products.filter((p) => selected.has(p.id)) : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3 no-print">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">Labels & Stickers</h1>
          <p className="text-brown text-sm font-medium">{products.length} coffee products — {selected.size} selected</p>
        </div>
        {canPrint && selected.size > 0 && (
          <button onClick={handlePrint} className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">
            <Printer size={18} /> Print Selected ({selected.size})
          </button>
        )}
      </div>

      <div className="relative no-print">
        <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input type="text" placeholder="Search products..." value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 no-print">
        {filtered.map((product) => (
          <div key={product.id} className={`relative cursor-pointer transition-all ${selected.has(product.id) ? "ring-2 ring-orange rounded-xl" : ""}`}
            onClick={() => toggleSelect(product.id)}>
            {selected.has(product.id) && (
              <div className="absolute -top-2 -right-2 w-6 h-6 bg-orange text-white rounded-full flex items-center justify-center text-xs font-bold z-10">
                {"✓"}
              </div>
            )}
            <LabelCard product={product} />
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="col-span-full text-center py-12 text-gray-400">
            <Tag size={40} className="mx-auto mb-2" /><p>No products found</p>
          </div>
        )}
      </div>

      {toPrint.length > 0 && (
        <div ref={printRef} className="hidden print:block">
          <div className="flex flex-wrap gap-6 justify-center">
            {toPrint.map((product) => (
              <LabelCard key={product.id} product={product} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
