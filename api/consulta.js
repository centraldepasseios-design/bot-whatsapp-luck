// api/consulta.js
// Webhook da Z-API: recebe mensagem do WhatsApp, consulta a reserva e responde.

const { consultarReserva } = require("./_cerebro.js");
const AUTORIZADOS = require("./_autorizados.json");

const ZAPI_TEXT =
  "https://api.z-api.io/instances/3F32A3E55237818FBDBE36ADC5527576/token/ECA321B4DA2EB4B2FF4CB937/send-text";

function autorizado(phone) {
  const norm = (n) => {
    n = String(n || "").replace(/\D/g, "");
    if (n.startsWith("55")) n = n.slice(2);
    if (n.length === 11 && n[2] === "9") n = n.slice(0, 2) + n.slice(3);
    return n;
  };
  const alvo = norm(phone);
  return AUTORIZADOS.some((a) => norm(a) === alvo);
}

async function responder(phone, mensagem) {
  await fetch(ZAPI_TEXT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": process.env.ZAPI_CLIENT_TOKEN },
    body: JSON.stringify({ phone, message: mensagem }),
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.status(200).json({ ok: true }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  res.status(200).json({ ok: true }); // responde rapido para a Z-API

  try {
    if (body.fromMe) return;
    const phone = body.phone || body.participantPhone || "";
    const texto = (body.text && body.text.message) || body.message || body.body || "";
    if (!phone || !texto) return;

    if (!autorizado(phone)) {
      await responder(phone, "Desculpe, este número não tem acesso à consulta de reservas.");
      return;
    }

    const mRec = texto.match(/REC[-\s]?(\d{4,})/i) || texto.match(/\b(\d{5,})\b/);
    if (!mRec) return; // nao e consulta, ignora

    const numero = mRec[1];
    await responder(phone, "🔎 Consultando, um momento...");
    const resposta = await consultarReserva(numero, process.env.PHOENIX_EMAIL, process.env.PHOENIX_PASSWORD);
    await responder(phone, resposta);
  } catch (e) {
    try { await responder(body.phone, "⚠️ Erro: " + (e && e.message ? e.message : String(e))); } catch {}
  }
};
