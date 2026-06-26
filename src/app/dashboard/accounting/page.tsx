"use client";

import { Wallet } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";

export default function AccountingPage() {
  const { t } = useI18n();

  return (
    <div className="max-w-2xl mx-auto mt-10">
      <div className="bg-white rounded-xl shadow-sm border border-border p-8 text-center">
        <div className="w-14 h-14 rounded-full bg-orange/10 flex items-center justify-center mx-auto mb-4">
          <Wallet size={26} className="text-orange" />
        </div>
        <h1 className="text-xl font-bold text-charcoal mb-2">{t("accounting")}</h1>
        <p className="text-sm text-brown leading-relaxed">
          This module is a backend foundation only (Accounting S0). Chart of Accounts, tax
          categories, fiscal periods, and manual journal entries are available through the
          accounting API for administrators. No sales, purchase, payment, or POS accounting
          workflows are wired up yet.
        </p>
      </div>
    </div>
  );
}
