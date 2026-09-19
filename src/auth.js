import crypto from "node:crypto";

const SEGREDO = process.env.SESSION_SECRET || "troque-este-segredo-em-producao";
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias

export function gerarSalt() {
  return crypto.randomBytes(16).toString("hex");
}

export function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString("hex");
}

export function pinValido(pin, salt, hashArmazenado) {
  const hashCalculado = hashPin(pin, salt);
  const a = Buffer.from(hashCalculado, "hex");
  const b = Buffer.from(hashArmazenado, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function assinar(payloadBase64) {
  return crypto.createHmac("sha256", SEGREDO).update(payloadBase64).digest("hex");
}

export function gerarToken(customerId) {
  const payload = { customerId, exp: Date.now() + VALIDADE_MS };
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const assinatura = assinar(payloadBase64);
  return `${payloadBase64}.${assinatura}`;
}

export function verificarToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [payloadBase64, assinatura] = token.split(".");
  const assinaturaEsperada = assinar(payloadBase64);
  const a = Buffer.from(assinatura || "", "hex");
  const b = Buffer.from(assinaturaEsperada, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadBase64, "base64url").toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function middlewareAutenticado(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const payload = verificarToken(token);
  if (!payload) return res.status(401).json({ erro: "Sessão inválida ou expirada." });
  req.customerId = payload.customerId;
  next();
}

export function middlewareAdmin(req, res, next) {
  const senha = req.headers["x-admin-password"];
  if (!senha || senha !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ erro: "Senha de admin inválida." });
  }
  next();
}
