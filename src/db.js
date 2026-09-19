import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error(
    "❌ DATABASE_URL não configurada no .env — veja .env.example.\n" +
      "   Crie um Postgres grátis no Neon (https://neon.tech) e cole a connection string."
  );
  process.exit(1);
}

const ehLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ehLocal ? false : { rejectUnauthorized: false },
});

export const query = (texto, params) => pool.query(texto, params);

/* Cria as tabelas na primeira execução. Idempotente — pode rodar sempre no boot. */
export async function iniciarBanco() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id           SERIAL PRIMARY KEY,
      nome         TEXT NOT NULL,
      telefone     TEXT NOT NULL UNIQUE,
      pin_hash     TEXT NOT NULL,
      pin_salt     TEXT NOT NULL,
      pontos       INTEGER NOT NULL DEFAULT 0,
      criado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS orders (
      id                SERIAL PRIMARY KEY,
      customer_id       INTEGER REFERENCES customers(id),
      cliente_nome      TEXT,
      cliente_telefone  TEXT,
      cliente_email     TEXT,
      cliente_doc       TEXT,
      entrega_json      JSONB,
      itens_json        JSONB NOT NULL,
      subtotal          NUMERIC(10,2) NOT NULL DEFAULT 0,
      taxa_entrega      NUMERIC(10,2) NOT NULL DEFAULT 0,
      total             NUMERIC(10,2) NOT NULL,
      pontos_ganhos     INTEGER NOT NULL DEFAULT 0,
      pontos_resgatados INTEGER NOT NULL DEFAULT 0,
      -- aguardando_pagamento | pago | pendente | confirmado | cancelado
      status            TEXT NOT NULL DEFAULT 'aguardando_pagamento',
      pagamento_metodo  TEXT,          -- pix | cartao | dinheiro
      cakto_offer_id    TEXT,
      cakto_order_id    TEXT,
      cakto_ref_id      TEXT,
      pix_qrcode        TEXT,          -- copia e cola
      pix_expira_em     TEXT,
      checkout_url      TEXT,
      pago_em           TIMESTAMPTZ,
      criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmado_em     TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS orders_cakto_offer_idx ON orders (cakto_offer_id);
    CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

    -- Deduplicação de webhooks da Cakto (o mesmo evento pode chegar várias vezes).
    CREATE TABLE IF NOT EXISTS webhooks_processados (
      chave       TEXT PRIMARY KEY,
      recebido_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Sessão do WhatsApp (Baileys) do bot, pra sobreviver a restart do Render.
    -- Usada pela Fase 3; criada aqui pra não precisar de migração depois.
    CREATE TABLE IF NOT EXISTS wa_auth (
      chave     TEXT PRIMARY KEY,
      valor     JSONB NOT NULL,
      atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("✅ Banco pronto.");
}
