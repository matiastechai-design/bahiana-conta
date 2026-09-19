/*
 * Roda UMA vez, depois de preencher CAKTO_CLIENT_ID / CAKTO_CLIENT_SECRET no .env.
 *
 *   npm run setup-cakto
 *
 * Cria (se ainda não existir):
 *   1. o produto fixo "Pedido Bahianá"          → mostra CAKTO_PRODUCT_ID
 *   2. o webhook apontando pra PUBLIC_URL/webhooks/cakto → mostra CAKTO_WEBHOOK_SECRET
 *
 * Copie os dois valores pro .env (e pro painel do Render).
 */
import "dotenv/config";
import { listarProdutos, criarProduto, criarWebhook } from "../src/cakto.js";

const NOME_PRODUTO = "Pedido Bahianá";
const EVENTOS = ["purchase_approved", "purchase_refused", "refund", "chargeback", "pix_gerado"];

const pub = process.env.PUBLIC_URL;
if (!pub || !pub.startsWith("https://")) {
  console.error("❌ Configure PUBLIC_URL (https://...) no .env antes de rodar.");
  process.exit(1);
}

const lista = await listarProdutos();
const produtos = Array.isArray(lista) ? lista : lista.results || [];
let produto = produtos.find((p) => p.name === NOME_PRODUTO);

if (produto) {
  console.log(`ℹ️  Produto "${NOME_PRODUTO}" já existe.`);
} else {
  produto = await criarProduto({
    nome: NOME_PRODUTO,
    descricao: "Pedidos do site da Bahianá Açaí & Sorvetes (Cajuru, Curitiba/PR).",
  });
  console.log(`✅ Produto criado.`);
}
console.log(`\n   CAKTO_PRODUCT_ID=${produto.id}\n`);

const urlWebhook = `${pub.replace(/\/$/, "")}/webhooks/cakto`;
try {
  const wh = await criarWebhook({ url: urlWebhook, produtoId: produto.id, eventos: EVENTOS });
  console.log(`✅ Webhook criado → ${urlWebhook}`);
  console.log(`\n   CAKTO_WEBHOOK_SECRET=${wh.secret || wh.fields?.secret || "(veja no painel Cakto → Apps)"}\n`);
} catch (e) {
  console.error(`⚠️  Não consegui criar o webhook automaticamente: ${e.message}`);
  console.error(`   Crie manual no painel: Apps → novo → URL ${urlWebhook}, eventos: ${EVENTOS.join(", ")}`);
}

process.exit(0);
