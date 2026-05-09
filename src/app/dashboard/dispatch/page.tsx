"use client";

import { useState, useEffect } from "react";
import { Truck, Plus, Search } from "lucide-react";
import { formatDate } from "@/lib/utils";
import { useUser } from "../layout";
import { hasSubPrivilege } from "@/lib/auth";
import { useI18n } from "@/lib/i18n/context";

type OrderItem = {
  id: string; beanTypeName: string; quantityKg: number; productionStatus: string;
  deliveryStatus: string; deliveredQty: number; remainingQty: number;
  order: { orderNumber: number; customer: { name: string } };
};

export default function DispatchPage() {
  const { t } = useI18n();
  const [orders, setOrders] = useState<{ items: OrderItem[] }[]>([]);
  const [deliveries, setDeliveries] = useState<{ id: string; date: string; quantityKg: number; deliveryType: string; orderItem: { beanTypeName: string; order: { orderNumber: number; customer: { name: string } } } }[]>([]);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [selectedItem, setSelectedItem] = useState<OrderItem | null>(null);
  const [form, setForm] = useState({ quantityKg: 0, deliveryType: "full", notes: "" });

  const user = useUser();
  const canDeliver = hasSubPrivilege(user?.permissions ?? {}, "dispatch", "mark_delivered");

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    const [ordersRes, delRes] = await Promise.all([fetch("/api/orders"), fetch("/api/deliveries")]);
    if (ordersRes.ok) setOrders(await ordersRes.json());
    if (delRes.ok) setDeliveries(await delRes.json());
  }

  function startDelivery(item: OrderItem) {
    setSelectedItem(item);
    const remaining = item.quantityKg - item.deliveredQty;
    setForm({ quantityKg: remaining, deliveryType: remaining >= item.quantityKg ? "full" : "partial", notes: "" });
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch("/api/deliveries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderItemId: selectedItem!.id, ...form }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error);
      return;
    }
    setShowForm(false);
    loadData();
  }

  const readyItems = orders.flatMap((o: any) =>
    o.items.filter((i: any) => i.productionStatus === "Completed" && i.deliveryStatus !== "Delivered")
      .map((i: any) => ({ ...i, order: { orderNumber: o.orderNumber, customer: { name: o.customer?.name } } }))
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-charcoal">{t("dispatchTitle")}</h1>
        <p className="text-brown text-sm font-medium">{readyItems.length} {t("itemsReadyDelivery")}</p>
      </div>

      <div>
        <h2 className="font-semibold text-charcoal mb-3">{t("readyForDelivery")}</h2>
        {readyItems.length === 0 ? (
          <div className="text-center py-8 bg-white rounded-2xl border border-border text-muted-foreground">
            <Truck size={32} className="mx-auto mb-2" /><p>{t("noItemsDelivery")}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {readyItems.map((item) => {
              const remaining = item.quantityKg - item.deliveredQty;
              return (
                <div key={item.id} className="bg-white rounded-2xl border border-border p-4 flex items-center justify-between">
                  <div>
                    <p className="font-semibold">#{item.order.orderNumber} — {item.order.customer.name}</p>
                    <p className="text-sm text-brown font-medium">{item.beanTypeName} — {remaining}kg {t("remainingOfLabel")} {item.quantityKg}kg</p>
                    {item.deliveredQty > 0 && (
                      <div className="mt-1">
                        <div className="w-48 bg-muted rounded-full h-1.5">
                          <div className="bg-success h-1.5 rounded-full" style={{ width: `${(item.deliveredQty / item.quantityKg) * 100}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">{item.deliveredQty}kg {t("deliveredKgLabel")}</p>
                      </div>
                    )}
                  </div>
                  {canDeliver && (
                    <button onClick={() => startDelivery(item)}
                      className="px-4 py-2 bg-orange text-white rounded-lg text-sm hover:bg-orange-dark flex items-center gap-2 shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">
                      <Truck size={16} /> {t("deliver")}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-charcoal mb-3">{t("deliveryHistory")}</h2>
        <div className="relative mb-3">
          <Search size={18} className="absolute ltr:left-3 rtl:right-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input type="text" placeholder={t("searchDeliveries")} value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full ltr:pl-10 rtl:pr-10 pr-4 py-2.5 border-2 border-border rounded-xl bg-white focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" />
        </div>
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-cream">
              <tr>
                <th className="text-start px-4 py-3 font-semibold">{t("date")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("orderCol")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("customer")}</th>
                <th className="text-start px-4 py-3 font-semibold">{t("beanCol")}</th>
                <th className="text-end px-4 py-3 font-semibold">{t("qtyKg")}</th>
                <th className="text-center px-4 py-3 font-semibold">{t("type")}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {deliveries
                .filter((d) => `${d.orderItem.order.orderNumber} ${d.orderItem.order.customer.name} ${d.orderItem.beanTypeName}`.toLowerCase().includes(search.toLowerCase()))
                .map((d) => (
                <tr key={d.id} className="hover:bg-cream/50">
                  <td className="px-4 py-3 text-brown">{formatDate(d.date)}</td>
                  <td className="px-4 py-3">#{d.orderItem.order.orderNumber}</td>
                  <td className="px-4 py-3">{d.orderItem.order.customer.name}</td>
                  <td className="px-4 py-3">{d.orderItem.beanTypeName}</td>
                  <td className="px-4 py-3 text-end font-medium">{d.quantityKg}</td>
                  <td className="px-4 py-3 text-center">
                    <span className={`status-badge ${d.deliveryType === "full" ? "status-completed" : "status-partial"}`}>
                      {d.deliveryType === "full" ? t("fullBadge") : t("partialBadge")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {canDeliver && showForm && selectedItem && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-extrabold text-charcoal mb-1">{t("recordDelivery")}</h2>
            <p className="text-sm text-brown font-medium mb-4">#{selectedItem.order.orderNumber} — {selectedItem.beanTypeName}</p>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("quantityKg")}</label>
                <input type="number" step="0.01" value={form.quantityKg}
                  onChange={(e) => setForm({ ...form, quantityKg: parseFloat(e.target.value) || 0 })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" required />
                <p className="text-xs text-muted-foreground mt-1">{t("maxLabel")} {selectedItem.quantityKg - selectedItem.deliveredQty}kg</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("deliveryType")}</label>
                <select value={form.deliveryType} onChange={(e) => setForm({ ...form, deliveryType: e.target.value })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors">
                  <option value="full">{t("fullDelivery")}</option>
                  <option value="partial">{t("partialDelivery")}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-charcoal mb-1">{t("notes")}</label>
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="w-full px-3 py-2 border-2 border-border rounded-xl focus:border-orange focus:ring-2 focus:ring-orange/20 outline-none transition-colors" rows={2} />
              </div>
              <div className="flex gap-3">
                <button type="submit" className="flex-1 py-2 bg-orange text-white rounded-lg hover:bg-orange-dark shadow-md shadow-orange/20 hover:shadow-orange/35 active:scale-[0.98] transition-all duration-200 font-bold">{t("confirmDelivery")}</button>
                <button type="button" onClick={() => setShowForm(false)} className="flex-1 py-2 border border-border rounded-lg hover:bg-cream/50 transition-colors">{t("cancel")}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
