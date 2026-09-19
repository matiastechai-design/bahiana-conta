/*
 * Avisa o WhatsApp da loja quando um pedido é pago.
 *
 * Dois caminhos, os dois opcionais:
 *  - BOT_NOTIFY_URL  → faz POST pro bot (Fase 3), que manda a mensagem pela conta
 *                      da loja. Header Authorization: Bearer BOT_NOTIFY_TOKEN.
 *  - Sempre loga um link wa.me pronto (fallback manual enquanto o bot não está no ar).
 */

export async function avisarPedidoPago(pedido) {
  const linhas = (pedido.itens || [])
    .map((i) => `• ${i.qtd || 1}x ${i.nome}${i.detalhe ? ` (${i.detalhe})` : ""}`)
    .join("\n");

  const entrega = pedido.entrega
    ? `\nEntrega: ${pedido.entrega.rua || ""} ${pedido.entrega.numero || ""}` +
      `${pedido.entrega.bairro ? " - " + pedido.entrega.bairro : ""}` +
      `${pedido.entrega.complemento ? " (" + pedido.entrega.complemento + ")" : ""}`
    : "\nRetirada no balcão";

  const texto =
    `💜 Pedido #${pedido.id} PAGO (${pedido.pagamento_metodo})\n` +
    `Cliente: ${pedido.cliente_nome || "-"} — ${pedido.cliente_telefone || "-"}\n` +
    `${linhas}\n` +
    `Total: R$ ${Number(pedido.total).toFixed(2).replace(".", ",")}` +
    entrega;

  const numeroLoja = (process.env.LOJA_WHATSAPP || "").replace(/\D/g, "");
  if (numeroLoja) {
    console.log(
      `🔗 wa.me/${numeroLoja}?text=${encodeURIComponent(texto)}`
    );
  }

  const url = process.env.BOT_NOTIFY_URL;
  if (!url) return;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.BOT_NOTIFY_TOKEN || ""}`,
      },
      body: JSON.stringify({ pedidoId: pedido.id, texto, pedido }),
    });
    if (!resp.ok) console.error(`⚠️  bot /notify respondeu ${resp.status}`);
  } catch (e) {
    console.error("⚠️  não consegui avisar o bot:", e.message);
  }
}
