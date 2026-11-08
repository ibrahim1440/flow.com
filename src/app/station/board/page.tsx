"use client";
// /station/board — «لوحة الطلبات المباشرة» (D15, option C, approved by the owner 8 Nov 2026). Read-only. On a board
// device the shell opens it directly (nobody signs in); on any other browser, the person's own ERP session with the
// orders module (W1).
import { OrdersBoard } from "./_ui/OrdersBoard";

export default function OrdersBoardPage() {
  return <OrdersBoard />;
}
