import "dotenv/config";
import crypto from "node:crypto";

/*
 * Camada fina sobre a API pública da Cakto (https://api.cakto.com.br).
 *
 * A Cakto não cobra "valor avulso": todo pagamento aponta pra uma OFERTA de
 * preço fixo, que pertence a um PRODUTO. Estratégia da Bahianá:
 *   - 1 produto fixo "Pedido Bahianá" (id em CAKTO_PRODUCT_ID), criado uma vez
 *     pelo scripts/setup-cakto.mjs
 *   - a cada pedido, cria uma oferta nova com o valor exato do carrinho
 *   - cobra em cima dessa oferta (Pix com QR na hora, ou checkout hospedado)
 */

const BASE = process.env.CAKTO_BASE_URL || "https://api.cakto.com.br";

function exigir(nome) {
  const v = process.env[nome];
  if (!v) throw new Error(`${nome} não configurada no .env — veja .env.example`);
  return v;
}

/* ── Token OAuth (cacheado em memória) ── */
let _token = null;
let _tokenExpiraEm = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiraEm - 60_000) return _token;

  const resp = await fetch(`${BASE}/public_api/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: exigir("CAKTO_CLIENT_ID"),
      client_secret: exigir("CAKTO_CLIENT_SECRET"),
    }),
  });

  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(`Cakto /token ${resp.status}: ${JSON.stringify(j)}`);
  }
  _token = j.access_token;
  _tokenExpiraEm = Date.now() + (Number(j.expires_in) || 36000) * 1000;
  return _token;
}

async function api(caminho, { method = "GET", body, headers = {} } = {}) {
  const token = await getToken();
  const resp = await fetch(`${BASE}${caminho}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const texto = await resp.text();
  let j;
  try {
    j = texto ? JSON.parse(texto) : {};
  } catch {
    j = { raw: texto };
  }
  if (!resp.ok) {
    const err = new Error(`Cakto ${method} ${caminho} → ${resp.status}: ${texto}`);
    err.status = resp.status;
    err.body = j;
    throw err;
  }
  return j;
}

/* ── Produto (usado só pelo script de setup) ── */
export async function criarProduto({ nome, descricao }) {
  return api("/public_api/products/", {
    method: "POST",
    body: {
      name: nome,
      description: descricao || nome,
      type: "unique",
      price: 1, // preço base; o valor real vem sempre da oferta por pedido
    },
  });
}

export async function listarProdutos() {
  return api("/public_api/products/");
}

/* ── Oferta por pedido ── */
export async function criarOferta({ nome, valor }) {
  return api("/public_api/offers/", {
    method: "POST",
    body: {
      name: nome,
      price: Number(valor.toFixed(2)),
      currency: "BRL",
      product: exigir("CAKTO_PRODUCT_ID"),
      type: "unique",
      status: "active",
    },
  });
}

/* ── Cobrança ──
 * metodo: "pix" → cria cobrança Pix e devolve { qrCode, checkoutUrl, ... }
 * metodo: "cartao" → devolve o checkout hospedado da Cakto (Pix + cartão + 3DS)
 */
export async function criarCobranca({ offerId, metodo, cliente, pixExpiraSeg = 3600 }) {
  const customer = {
    name: cliente.nome,
    email: cliente.email,
    phone: cliente.telefone, // E.164, ex 5541999999999
  };
  if (cliente.doc) {
    customer.docType = cliente.doc.replace(/\D/g, "").length > 11 ? "cnpj" : "cpf";
    customer.docNumber = cliente.doc.replace(/\D/g, "");
  }

  if (metodo === "pix") {
    const r = await api("/public_api/payments/", {
      method: "POST",
      headers: { "X-Idempotency-Key": crypto.randomUUID() },
      body: {
        paymentMethod: "pix",
        customer,
        items: [{ offerId }],
        pixExpiresIn: pixExpiraSeg,
      },
    });
    return {
      caktoOrderId: r.id,
      refId: r.refId,
      status: r.status,
      checkoutUrl: r.checkoutUrl || null,
      pixQrCode: r.pix?.qrCode || null,
      pixExpiraEm: r.pix?.expirationDate || null,
    };
  }

  // cartão: manda a pessoa pro checkout hospedado (não dá pra tokenizar cartão
  // no servidor sem o SDK no navegador). Ainda criamos a cobrança Pix só pra
  // obter uma checkoutUrl estável ligada à mesma oferta.
  const r = await api("/public_api/payments/", {
    method: "POST",
    headers: { "X-Idempotency-Key": crypto.randomUUID() },
    body: {
      paymentMethod: "pix",
      customer,
      items: [{ offerId }],
      pixExpiresIn: pixExpiraSeg,
    },
  });
  return {
    caktoOrderId: r.id,
    refId: r.refId,
    status: r.status,
    checkoutUrl: r.checkoutUrl || null,
    pixQrCode: null,
    pixExpiraEm: null,
  };
}

/* ── Webhook ── */
export async function criarWebhook({ url, produtoId, eventos }) {
  return api("/public_api/webhook/", {
    method: "POST",
    body: {
      name: "Bahianá — pedidos do site",
      url,
      products: [produtoId],
      events: eventos,
      status: "active",
    },
  });
}

const TOLERANCIA_SEG = 5 * 60;

/* Valida a origem: 1º tenta a assinatura no header, senão o campo secret no corpo. */
export function webhookConfere({ corpoCru, timestamp, assinatura, secretNoCorpo }) {
  const segredo = process.env.CAKTO_WEBHOOK_SECRET;
  if (!segredo) return false;

  if (timestamp && assinatura) {
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCIA_SEG) return false;
    const esperado =
      "v1=" +
      crypto.createHmac("sha256", segredo).update(`${timestamp}.`).update(corpoCru).digest("hex");
    const a = Buffer.from(assinatura);
    const b = Buffer.from(esperado);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  if (secretNoCorpo) {
    const a = Buffer.from(secretNoCorpo);
    const b = Buffer.from(segredo);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  return false;
}
