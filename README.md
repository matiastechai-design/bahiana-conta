# Bahianá — backend de pedidos, pagamento e pontos

Servidor que dá ao site do cardápio: **checkout com pagamento (Pix + cartão via
Cakto)**, registro de pedidos, conta de cliente com **pontos de fidelidade** e um
**painel admin** pra acompanhar os pedidos.

## Como o pagamento funciona (Cakto)

A Cakto é um gateway brasileiro (BRL, Pix, cartão nacional, CPF/CNPJ) — feito pro
Brasil. Ela não cobra "valor avulso": todo pagamento aponta pra uma *oferta* de
preço fixo. Por isso o backend:

1. Mantém **1 produto fixo** "Pedido Bahianá" (criado uma vez pelo `setup-cakto`).
2. A cada pedido, cria uma **oferta** com o valor exato do carrinho.
3. Cobra em cima dela: Pix gera QR na hora; cartão vai pro checkout hospedado da Cakto.
4. Quando a Cakto confirma o pagamento (`webhook purchase_approved`), o pedido vira
   `pago`, os pontos entram na conta do cliente e o WhatsApp da loja é avisado.

> ⚠️ A Cakto é focada em infoproduto/curso digital. Vender comida (produto físico)
> pode esbarrar nos termos de uso — confirme com o suporte da Cakto antes de divulgar.

## Rodar local

1. `cp .env.example .env` e preencher:
   - `DATABASE_URL` — Postgres. Grátis e persistente no [Neon](https://neon.tech).
   - `ADMIN_PASSWORD`, `SESSION_SECRET`
   - `CAKTO_CLIENT_ID` / `CAKTO_CLIENT_SECRET` — Painel Cakto → Integrações → Cakto API
     → Criar Chave (escopos: read, write, products, offers, orders, payments, webhooks)
   - `PUBLIC_URL` — a URL pública do backend (pro webhook). Local: use um túnel
     (ex. `ngrok http 3300`) e ponha a URL do túnel.
2. `npm install`
3. `npm run setup-cakto` — cria o produto e o webhook; copie `CAKTO_PRODUCT_ID` e
   `CAKTO_WEBHOOK_SECRET` que ele imprime pro `.env`.
4. `npm start`
   - Portal do cliente: http://localhost:3300/conta.html
   - Painel admin: http://localhost:3300/admin.html

## Deploy no Render (grátis)

1. Suba este projeto pro GitHub.
2. Render → **New → Blueprint** → aponta pro repositório (ele lê o `render.yaml`).
3. Nas *Environment Variables* do serviço, preencha os valores marcados `sync: false`
   (`DATABASE_URL` do Neon, `ADMIN_PASSWORD`, `PUBLIC_URL` = a própria URL do Render,
   as chaves da Cakto).
4. Depois do primeiro deploy, rode o `setup-cakto` (localmente, com `PUBLIC_URL`
   apontando pro Render) e cole `CAKTO_PRODUCT_ID` / `CAKTO_WEBHOOK_SECRET` no Render.
5. Redeploy.

> O plano free do Render "dorme" após 15 min sem uso — o primeiro pedido depois
> de um tempo ocioso demora ~50s. Aceitável pro checkout; some com isso subindo
> pro plano pago mais tarde se precisar.

## Endpoints principais

| Método | Rota | Pra quê |
|---|---|---|
| POST | `/api/checkout` | site cria o pedido + cobrança, recebe QR Pix / link do cartão |
| GET | `/api/pedido/:id` | site consulta em loop até o Pix cair |
| POST | `/webhooks/cakto` | Cakto avisa pagamento → pedido `pago` + pontos + WhatsApp |
| POST | `/api/signup`, `/api/login`, GET `/api/me` | conta do cliente |
| GET | `/api/admin/orders`, `/api/admin/customers[.csv]` | painel |

## Banco

Postgres. As tabelas são criadas sozinhas no boot (`src/db.js`). Tabela `wa_auth`
já fica pronta pra Fase 3 (sessão do bot do WhatsApp).
