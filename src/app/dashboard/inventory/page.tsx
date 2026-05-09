"use client";

import { useState, useEffect } from "react";
import { Plus, Package, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

type GreenBean = {
  id: string; serialNumber: string; beanType: string; country: string;
  region: string | null; variety: string | null; process: string | null;
  altitude: string | null; location: string | null; quantityKg: number;
  receivedDate: string; createdAt: string;
};

export default function InventoryPage() {
  const user = useUser();
  const { t } = useI18n();
  const canReceive = !!user && hasSubPrivilege(user.permissions, "inventory", "receive");
  const canAdjust = !!user && hasSubPrivilege(user.permissions, "inventory", "adjust");

  const [beans, setBeans] = useState<GreenBean[]>([]);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    serialNumber: "", beanType: "", country: "", region: "", variety: "",
    process: "", altitude: "", location: "", quantityKg: 0,
  });

  useEffect(() => { loadBeans(); }, []);

  async function loadBeans() {
    const res = await fetch("/api/green-beans");
    setBeans(await res.json());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    await fetch("/api/green-beans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setShowForm(false);
    setForm({ serialNumber: "", beanType: "", country: "", region: "", variety: "", process: "", altitude: "", location: "", quantityKg: 0 });
    loadBeans();
  }

  const filtered = beans.filter((b) =>
    `${b.beanType} ${b.country} ${b.serialNumber}`.toLowerCase().includes(search.toLowerCase())
  );
  const totalStock = beans.reduce((s, b) => s + b.quantityKg, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold text-charcoal">{t("greenBeanInventory")}</h1>
          <p className="text-brown text-sm font-medium">{t("totalStock")}: {totalStock.toFixed(1)} kg {t("from")} {beans.length} {t("varieties")}</p>
        </div>
        {canReceive && (
          <button onClick={() => setShowForm(true)} className="flex items-center gap-2 px-4 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">
            <Plus size={18} /> {t("addStock")}
          </button>
        )}
      </div>

      <div className="relative">
        <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text" placeholder={t("searchBeans")} value={search} onChange={(e) => setSearch(e.target.value)}
          className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
        />
      </div>

      {showForm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-charcoal mb-4">{t("registerNewStock")}</h2>
            <form onSubmit={handleSubmit} className="space-y-3">
              {[
                { key: "serialNumber", labelKey: "serialNumber", required: true },
                { key: "beanType", labelKey: "beanType", required: true },
                { key: "country", labelKey: "country", required: true },
                { key: "region", labelKey: "region" },
                { key: "variety", labelKey: "variety" },
                { key: "process", labelKey: "process" },
                { key: "altitude", labelKey: "altitude" },
                { key: "location", labelKey: "storageLocation" },
              ].map(({ key, labelKey, required }) => (
                <div key={key}>
                  <label className="block text-sm font-medium text-gray-700 mb-1">{t(labelKey as any)}</label>
                  <input
                    type="text" value={(form as Record<string, string | number>)[key] as string}
                    onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors"
                    required={required}
                  />
                </div>
              ))}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{t("quantityKg")}</label>
                <input
                  type="number" step="0.01" value={form.quantityKg}
                  onChange={(e) => setForm({ ...form, quantityKg: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required
                />
              </div>
              <div className="flex gap-3 pt-2">
                <button type="submit" className="flex-1 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">{t("save")}</button>
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2 border border-gray-300 rounded-lg hover:bg-gray-50">{t("cancel")}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-cream">
              <tr>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("serialNumberShort")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("beanType")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("origin")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("process")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("altitude")}</th>
                <th className="text-end px-4 py-3 font-semibold text-charcoal">{t("stockKg")}</th>
                <th className="text-start px-4 py-3 font-semibold text-charcoal">{t("received")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((bean) => (
                <tr key={bean.id} className="hover:bg-cream/50">
                  <td className="px-4 py-3 font-mono text-xs">{bean.serialNumber}</td>
                  <td className="px-4 py-3 font-medium">{bean.beanType}</td>
                  <td className="px-4 py-3">{bean.country}{bean.region ? ` / ${bean.region}` : ""}</td>
                  <td className="px-4 py-3">{bean.process || "—"}</td>
                  <td className="px-4 py-3">{bean.altitude || "—"}</td>
                  <td className="px-4 py-3 text-end">
                    <span className={`font-bold ${bean.quantityKg < 20 ? "text-red-600" : "text-green-600"}`}>
                      {bean.quantityKg}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-brown">{formatDate(bean.receivedDate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-gray-400">
            <Package size={40} className="mx-auto mb-2" />
            <p>{t("noBeansFound")}</p>
          </div>
        )}
      </div>
    </div>
  );
}
