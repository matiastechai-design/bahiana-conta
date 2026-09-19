import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, iniciarBanco } from "./db.js";
import {
  gerarSalt,
  hashPin,
  pinValido,
  gerarToken,
  verificarToken,
  middlewareAutenticado,
  middlewareAdmin,
} from "./auth.js";
import { criarOferta, criarCobranca, webhookConfere } from "./cakto.js";
import { avisarPedidoPago } from "./notify.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.ADMIN_PASSWORD) {
  console.error("❌ ADMIN_PASSWORD não configurada no .env — veja .env.example.");
  process.exit(1);
}

const PORTA = process.env.PORT || 3300;
const PONTOS_POR_REAL = 1;

const app = express();
app.set("trust proxy", 1);
app.use(cors());
// guarda o corpo cru pra validar a assinatura do webhook da Cakto
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));
app.use(express.static(path.join(__dirname, "..", "public")));

const limparTelefone = (t) => String(t || "").replace(/\D/g, "");
const clienteJSON = (c) => ({
  id: c.id,
  nome: c.nome,
  telefone: c.telefone,
  pontos: c.pontos,
  criadoEm: c.criado_em,
});

app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ══════════════ Conta do cliente ══════════════ */

app.post("/api/signup", async (req, res, next) => {
  try {
    const { nome, telefone, pin } = req.body || {};
    const tel = limparTelefone(telefone);
    if (!nome || nome.trim().length < 2) return res.status(400).json({ erro: "Informe seu nome." });
    if (tel.length < 10) return res.status(400).json({ erro: "Telefone inválido." });
    if (!/^\d{4}$/.test(String(pin || ""))) return res.status(400).json({ erro: "A senha precisa ter 4 números." });

    const existe = await query("SELECT id FROM customers WHERE telefone = $1", [tel]);
    if (existe.rowCount) return res.status(409).json({ erro: "Já existe uma conta com esse telefone. Faça login." });

    const salt = gerarSalt();
    const hash = hashPin(pin, salt);
    const { rows } = await query(
      "INSERT INTO customers (nome, telefone, pin_hash, pin_salt) VALUES ($1,$2,$3,$4) RETURNING *",
      [nome.trim(), tel, hash, salt]
    );
    res.json({ token: gerarToken(rows[0].id), cliente: clienteJSON(rows[0]) });
  } catch (e) {
    next(e);
  }
});

app.post("/api/login", async (req, res, next) => {
  try {
    const { telefone, pin } = req.body || {};
    const { rows } = await query("SELECT * FROM customers WHERE telefone = $1", [limparTelefone(telefone)]);
    const cliente = rows[0];
    if (!cliente || !pinValido(pin, cliente.pin_salt, cliente.pin_hash)) {
      return res.status(401).json({ erro: "Telefone ou senha incorretos." });
    }
    res.json({ token: gerarToken(cliente.id), cliente: clienteJSON(cliente) });
  } catch (e) {
    next(e);
  }
});

app.get("/api/me", middlewareAutenticado, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM customers WHERE id = $1", [req.customerId]);
    if (!rows[0]) return res.status(404).json({ erro: "Cliente não encontrado." });
    const pedidos = await query(
      `SELECT id, total, pontos_ganhos, status, criado_em
       FROM orders WHERE customer_id = $1 ORDER BY id DESC LIMIT 20`,
      [req.customerId]
    );
    res.json({ cliente: clienteJSON(rows[0]), pedidos: pedidos.rows });
  } catch (e) {
    next(e);
  }
});

/* ══════════════ Checkout com pagamento (site do cardápio) ══════════════ */

function clienteDoTokenOpcional(req) {
  const auth = req.headers.authorization || "";
  const payload = auth.startsWith("Bearer ") ? verificarToken(auth.slice(7)) : null;
  return payload?.customerId || null;
}

app.post("/api/checkout", async (req, res, next) => {
  try {
    const { itens, subtotal = 0, taxaEntrega = 0, total, pagamento, cliente = {}, entrega = null } =
      req.body || {};

    if (!Array.isArray(itens) || itens.length === 0)
      return res.status(400).json({ erro: "Carrinho vazio." });
    if (typeof total !== "number" || total <= 0)
      return res.status(400).json({ erro: "Total inválido." });
    if (!["pix", "cartao"].includes(pagamento))
      return res.status(400).json({ erro: "Forma de pagamento inválida." });
    if (!cliente.nome || !cliente.telefone)
      return res.status(400).json({ erro: "Informe nome e telefone." });

    // confere o total contra a soma dos itens (evita adulteração no front)
    const somaItens = itens.reduce((s, i) => s + Number(i.preco || 0) * Number(i.qtd || 1), 0);
    if (Math.abs(somaItens + Number(taxaEntrega) - total) > 0.02)
      return res.status(400).json({ erro: "Total não bate com os itens." });

    const customerId = clienteDoTokenOpcional(req);
    const pontosGanhos = Math.floor(total * PONTOS_POR_REAL);
    const telE164 = limparTelefone(cliente.telefone).replace(/^0+/, "");
    const tel = telE164.startsWith("55") ? telE164 : "55" + telE164;

    const { rows } = await query(
      `INSERT INTO orders
         (customer_id, cliente_nome, cliente_telefone, cliente_email, cliente_doc,
          entrega_json, itens_json, subtotal, taxa_entrega, total, pontos_ganhos,
          status, pagamento_metodo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'aguardando_pagamento',$12)
       RETURNING id`,
      [
        customerId,
        cliente.nome,
        tel,
        cliente.email || null,
        cliente.doc || null,
        entrega ? JSON.stringify(entrega) : null,
        JSON.stringify(itens),
        subtotal,
        taxaEntrega,
        total,
        pontosGanhos,
        pagamento,
      ]
    );
    const pedidoId = rows[0].id;

    // 1. oferta com o valor do carrinho  2. cobrança
    const oferta = await criarOferta({ nome: `Pedido #${pedidoId} — Bahianá`, valor: total });
    const cobranca = await criarCobranca({
      offerId: oferta.id,
      metodo: pagamento,
      cliente: { nome: cliente.nome, email: cliente.email || "cliente@bahiana.app", telefone: tel, doc: cliente.doc },
    });

    await query(
      `UPDATE orders SET cakto_offer_id=$1, cakto_order_id=$2, cakto_ref_id=$3,
              pix_qrcode=$4, pix_expira_em=$5, checkout_url=$6 WHERE id=$7`,
      [
        oferta.id,
        cobranca.caktoOrderId || null,
        cobranca.refId || null,
        cobranca.pixQrCode,
        cobranca.pixExpiraEm,
        cobranca.checkoutUrl,
        pedidoId,
      ]
    );

    res.json({
      pedidoId,
      pagamento,
      pixQrCode: cobranca.pixQrCode,
      pixExpiraEm: cobranca.pixExpiraEm,
      checkoutUrl: cobranca.checkoutUrl,
      pontosGanhos,
    });
  } catch (e) {
    next(e);
  }
});

/* status do pedido — o site consulta em loop até o Pix cair */
app.get("/api/pedido/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT id, status, total, pagamento_metodo, pago_em, pontos_ganhos FROM orders WHERE id = $1",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ erro: "Pedido não encontrado." });
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

/* ══════════════ Pedido de cliente logado sem pagamento online (legado) ══════════════ */
app.post("/api/orders", middlewareAutenticado, async (req, res, next) => {
  try {
    const { itens, subtotal, taxaEntrega, total } = req.body || {};
    if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: "Pedido sem itens." });
    if (typeof total !== "number" || total <= 0) return res.status(400).json({ erro: "Total inválido." });
    const pontosGanhos = Math.floor(total * PONTOS_POR_REAL);
    const { rows } = await query(
      `INSERT INTO orders (customer_id, itens_json, subtotal, taxa_entrega, total, pontos_ganhos, status, pagamento_metodo)
       VALUES ($1,$2,$3,$4,$5,$6,'pendente','dinheiro') RETURNING id`,
      [req.customerId, JSON.stringify(itens), subtotal || 0, taxaEntrega || 0, total, pontosGanhos]
    );
    res.json({ pedidoId: rows[0].id, pontosGanhos });
  } catch (e) {
    next(e);
  }
});

/* ══════════════ Webhook da Cakto ══════════════ */
app.post("/webhooks/cakto", async (req, res) => {
  const ok = webhookConfere({
    corpoCru: req.rawBody || Buffer.from(JSON.stringify(req.body || {})),
    timestamp: req.headers["x-cakto-timestamp"],
    assinatura: req.headers["x-cakto-signature"],
    secretNoCorpo: req.body?.secret,
  });
  if (!ok) return res.status(401).send("unauthorized");

  // responde rápido; processa depois (a Cakto dá timeout em 8s)
  res.sendStatus(200);

  try {
    const { event, data } = req.body || {};
    if (!data || Array.isArray(data)) return; // ignora webhook V2 (lista) por ora
    if (!["purchase_approved"].includes(event)) return;

    const chave = `${event}:${data.id}`;
    const dedupe = await query(
      "INSERT INTO webhooks_processados (chave) VALUES ($1) ON CONFLICT DO NOTHING RETURNING chave",
      [chave]
    );
    if (!dedupe.rowCount) return; // já processado

    const offerId = data.offer?.id;
    const { rows } = await query(
      `SELECT * FROM orders
       WHERE (cakto_offer_id = $1 OR cakto_order_id = $2)
         AND status = 'aguardando_pagamento'
       ORDER BY id DESC LIMIT 1`,
      [offerId, data.id]
    );
    const pedido = rows[0];
    if (!pedido) {
      console.warn(`webhook: pedido não encontrado (offer=${offerId}, cakto=${data.id})`);
      return;
    }

    await query(
      "UPDATE orders SET status='pago', pago_em=now(), cakto_order_id=$1, cakto_ref_id=$2 WHERE id=$3",
      [data.id, data.refId || pedido.cakto_ref_id, pedido.id]
    );
    if (pedido.customer_id && pedido.pontos_ganhos > 0) {
      await query("UPDATE customers SET pontos = pontos + $1 WHERE id = $2", [
        pedido.pontos_ganhos,
        pedido.customer_id,
      ]);
    }

    await avisarPedidoPago({
      ...pedido,
      status: "pago",
      itens: pedido.itens_json,
      entrega: pedido.entrega_json,
    });
    console.log(`✅ Pedido #${pedido.id} pago (Cakto ${data.refId || data.id}).`);
  } catch (e) {
    console.error("erro processando webhook:", e);
  }
});

/* ══════════════ Admin ══════════════ */

app.get("/api/admin/customers", middlewareAdmin, async (_req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT c.id, c.nome, c.telefone, c.pontos, c.criado_em,
             COUNT(o.id) AS total_pedidos,
             COALESCE(SUM(CASE WHEN o.status IN ('pago','confirmado') THEN o.total ELSE 0 END), 0) AS total_gasto
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.criado_em DESC`);
    res.json({ clientes: rows });
  } catch (e) {
    next(e);
  }
});

app.get("/api/admin/customers.csv", middlewareAdmin, async (_req, res, next) => {
  try {
    const { rows } = await query("SELECT nome, telefone, pontos, criado_em FROM customers ORDER BY criado_em DESC");
    const linhas = [
      "nome,telefone,pontos,cadastrado_em",
      ...rows.map((c) => `"${c.nome}",${c.telefone},${c.pontos},${c.criado_em}`),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=clientes-bahiana.csv");
    res.send(linhas.join("\n"));
  } catch (e) {
    next(e);
  }
});

app.get("/api/admin/orders", middlewareAdmin, async (req, res, next) => {
  try {
    const { status } = req.query;
    const sql = `
      SELECT o.*, c.nome AS cliente_nome_conta, c.telefone AS cliente_telefone_conta
      FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      ${status ? "WHERE o.status = $1" : ""}
      ORDER BY o.id DESC LIMIT 200`;
    const { rows } = await query(sql, status ? [status] : []);
    res.json({
      pedidos: rows.map((p) => ({
        ...p,
        itens: p.itens_json,
        entrega: p.entrega_json,
        cliente_nome: p.cliente_nome || p.cliente_nome_conta,
        cliente_telefone: p.cliente_telefone || p.cliente_telefone_conta,
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/admin/orders/:id/confirmar", middlewareAdmin, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
    const pedido = rows[0];
    if (!pedido) return res.status(404).json({ erro: "Pedido não encontrado." });
    if (!["pendente", "pago"].includes(pedido.status))
      return res.status(400).json({ erro: "Pedido já foi processado." });

    await query("UPDATE orders SET status='confirmado', confirmado_em=now() WHERE id=$1", [pedido.id]);
    // credita pontos só se ainda não creditou (pedido 'pendente' = pago na entrega)
    if (pedido.status === "pendente" && pedido.customer_id && pedido.pontos_ganhos > 0) {
      await query("UPDATE customers SET pontos = pontos + $1 WHERE id = $2", [
        pedido.pontos_ganhos,
        pedido.customer_id,
      ]);
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/admin/orders/:id/cancelar", middlewareAdmin, async (req, res, next) => {
  try {
    const { rows } = await query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ erro: "Pedido não encontrado." });
    await query("UPDATE orders SET status='cancelado' WHERE id=$1", [rows[0].id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

/* ══════════════ erro genérico ══════════════ */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ erro: "Erro interno.", detalhe: String(err.message || err) });
});

iniciarBanco()
  .then(() => {
    app.listen(PORTA, () => {
      console.log(`✅ Backend Bahianá em http://localhost:${PORTA}`);
      console.log(`   Portal do cliente: /conta.html   |   Admin: /admin.html`);
    });
  })
  .catch((e) => {
    console.error("❌ Falha ao iniciar o banco:", e);
    process.exit(1);
  });
