// api/checkout.js
// Serverless Function (Vercel) — recebe o carrinho + dados do cliente,
// valida cada preço direto na tabela `products` do Supabase (nunca confia
// no preço enviado pelo navegador), grava o pedido em `orders` como
// "pending" e devolve o link de pagamento (init_point) do Mercado Pago.
//
// Variáveis de ambiente necessárias:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   MERCADOPAGO_ACCESS_TOKEN
//   DOMAIN_URL   (ex: https://grifedaspratas.com.br, sem barra no final)

import { createClient } from "@supabase/supabase-js";
import { MercadoPagoConfig, Preference } from "mercadopago";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN,
});

function cleanDomain(url) {
  return String(url || "").replace(/\/+$/, "");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const { items, customer } = body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Carrinho vazio ou inválido." });
    }
    if (!customer || !customer.name || !customer.email) {
      return res.status(400).json({ error: "Informe nome e e-mail para continuar." });
    }

    // ---- 1) Valida cada item direto na tabela products (fonte da verdade de preço) ----
    const ids = [...new Set(items.map((item) => item.id))].filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: "Itens do carrinho sem identificação válida." });
    }

    const { data: dbProducts, error: productsError } = await supabase
      .from("products")
      .select("id, name, price, active, sizes")
      .in("id", ids);

    if (productsError) throw productsError;

    const productsById = new Map((dbProducts || []).map((p) => [p.id, p]));
    const validatedItems = [];
    let total = 0;

    for (const rawItem of items) {
      const product = productsById.get(rawItem.id);

      if (!product) {
        return res.status(400).json({ error: `Produto não encontrado: ${rawItem.id}` });
      }
      if (product.active === false) {
        return res.status(400).json({ error: `Produto indisponível no momento: ${product.name}` });
      }

      const quantity = Number.isFinite(Number(rawItem.quantity)) && Number(rawItem.quantity) > 0
        ? Math.floor(Number(rawItem.quantity))
        : 1;

      // Se o produto tem tamanhos cadastrados, o tamanho escolhido precisa ser um deles
      if (Array.isArray(product.sizes) && product.sizes.length > 0) {
        if (!rawItem.size || !product.sizes.includes(rawItem.size)) {
          return res.status(400).json({
            error: `Selecione um tamanho válido para "${product.name}".`,
          });
        }
      }

      const unitPrice = Number(product.price); // preço vem do banco, não do cliente
      total += unitPrice * quantity;

      validatedItems.push({
        product_id: product.id,
        name: product.name,
        size: rawItem.size ?? null,
        quantity,
        unit_price: unitPrice,
      });
    }

    // ---- 2) Cria o pedido como "pending" ----
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .insert({
        status: "pending",
        items: validatedItems,
        total,
        customer_name: customer.name,
        customer_email: customer.email,
        customer_phone: customer.phone ?? null,
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // ---- 3) Cria a preferência de pagamento no Mercado Pago ----
    const domain = cleanDomain(process.env.DOMAIN_URL);
    const preference = new Preference(mpClient);

    const mpResponse = await preference.create({
      body: {
        items: validatedItems.map((item) => ({
          title: item.size ? `${item.name} (Tam. ${item.size})` : item.name,
          quantity: item.quantity,
          unit_price: item.unit_price,
          currency_id: "BRL",
        })),
        payer: {
          name: customer.name,
          email: customer.email,
          ...(customer.phone ? { phone: { number: String(customer.phone) } } : {}),
        },
        external_reference: order.id,
        notification_url: `${domain}/api/webhook`,
        back_urls: {
          success: `${domain}/sucesso.html?pedido=${order.id}`,
          failure: `${domain}/erro.html?pedido=${order.id}`,
          pending: `${domain}/pendente.html?pedido=${order.id}`,
        },
        auto_return: "approved",
        statement_descriptor: "GRIFE DAS PRATAS",
      },
    });

    // ---- 4) Guarda o id da preferência no pedido ----
    await supabase
      .from("orders")
      .update({ mp_preference_id: mpResponse.id })
      .eq("id", order.id);

    return res.status(200).json({
      order_id: order.id,
      preference_id: mpResponse.id,
      init_point: mpResponse.init_point,
    });
  } catch (err) {
    console.error("Erro no checkout:", err);
    return res.status(500).json({ error: "Não foi possível processar o pedido. Tente novamente." });
  }
}
