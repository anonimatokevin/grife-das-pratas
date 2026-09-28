// api/webhook.js
// Serverless Function (Vercel) — recebe a notificação do Mercado Pago,
// confirma o status direto na API do Mercado Pago (nunca confia apenas
// no payload recebido) e atualiza o pedido correspondente no Supabase.
//
// Variáveis de ambiente necessárias:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   MERCADOPAGO_ACCESS_TOKEN

import { createClient } from "@supabase/supabase-js";
import { MercadoPagoConfig, Payment } from "mercadopago";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

// Mapeia os status de pagamento do Mercado Pago para o status do pedido
function mapOrderStatus(mpStatus) {
  switch (mpStatus) {
    case "approved":
      return "paid";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "refunded":
    case "charged_back":
      return "refunded";
    case "in_process":
    case "pending":
      return "pending";
    default:
      return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).end();
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const query = req.query || {};

    // O Mercado Pago pode notificar via query string (?type=payment&data.id=123)
    // ou via corpo da requisição { type/topic, data: { id } }
    const type = query.type || body.type || body.topic;
    const paymentId = query["data.id"] || body?.data?.id || query.id || body?.resource;

    if (type !== "payment" || !paymentId) {
      // Notificações de outros tópicos (merchant_order, etc.) são apenas confirmadas
      return res.status(200).json({ received: true });
    }

    // Busca o pagamento direto na API do Mercado Pago — fonte da verdade,
    // nunca confiamos só no que veio na notificação
    const payment = new Payment(mpClient);
    const paymentInfo = await payment.get({ id: paymentId });

    const orderId = paymentInfo?.external_reference;
    if (!orderId) {
      return res.status(200).json({ received: true });
    }

    const newStatus = mapOrderStatus(paymentInfo.status);
    if (!newStatus) {
      return res.status(200).json({ received: true });
    }

    const { error } = await supabase
      .from("orders")
      .update({
        status: newStatus,
        mp_payment_id: paymentInfo.id,
        payment_status_detail: paymentInfo.status_detail ?? null,
        paid_at: newStatus === "paid" ? new Date().toISOString() : null,
      })
      .eq("id", orderId);

    if (error) throw error;

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Erro no webhook do Mercado Pago:", err);
    // 500 para que o Mercado Pago reenvie a notificação em falhas transitórias
    return res.status(500).json({ error: "Erro ao processar notificação." });
  }
}
