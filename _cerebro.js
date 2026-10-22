// _cerebro.js
// Nucleo compartilhado: login no Phoenix + consulta de reserva.
// Usado pela funcao de webhook do WhatsApp.

const BASE = "https://recife.phoenix.comeialabs.com";

function guardarCookies(arr, jar) {
  for (const sc of arr || []) {
    const p = sc.split(";")[0]; const i = p.indexOf("=");
    if (i > -1) jar[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
}
const cookieHdr = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");

async function login(email, senha) {
  const jar = {};
  const r1 = await fetch(`${BASE}/login`, { redirect: "manual" });
  guardarCookies(r1.headers.getSetCookie(), jar);
  const html = await r1.text();
  let csrf = (html.match(/name="_csrf-backend"[^>]*value="([^"]+)"/) || [])[1];
  if (!csrf) csrf = (html.match(/<meta name="csrf-token" content="([^"]+)"/) || [])[1];
  if (!csrf) throw new Error("csrf");
  const body = new URLSearchParams();
  body.set("_csrf-backend", csrf);
  body.set("LoginForm[username]", email);
  body.set("LoginForm[password]", senha);
  const r2 = await fetch(`${BASE}/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHdr(jar), Referer: `${BASE}/login` },
    body: body.toString(),
  });
  guardarCookies(r2.headers.getSetCookie(), jar);
  if (r2.status !== 302) throw new Error("login falhou");
  return jar;
}

async function getText(caminho, jar) {
  const r = await fetch(`${BASE}${caminho}`, { headers: { Cookie: cookieHdr(jar), Referer: `${BASE}/` } });
  if (!r.ok) throw new Error(`erro ${r.status}`);
  return r.text();
}
function soTexto(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"")
    .replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/\s+/g," ").trim();
}

async function lerReserva(numero, jar) {
  const html = await getText(`/new-reserve/finish-view-list/${numero}`, jar);
  let txt = soTexto(html);
  const ini = txt.indexOf("Código da Reserva");
  if (ini > -1) txt = txt.slice(ini);
  const dados = {
    codigo: (txt.match(/Código da Reserva\s+(REC-\d+)/i) || [])[1] || null,
    cliente: (txt.match(/Cliente\s+(.+?)\s+(?:Telefone|Moeda|Observa|Idioma|Voucher)/i) || [])[1] || null,
    telefone: (txt.match(/Telefone de Contato\s+([+\d\s().-]{8,}?)\s+(?:Moeda|Observa|Idioma)/i) || [])[1] || null,
    observacao: (txt.match(/Observação\s+(.+?)\s+(?:Idioma|Voucher|Localizador)/i) || [])[1] || null,
    idioma: (txt.match(/Idioma\s+([A-Za-zÀ-ÿ]+)/i) || [])[1] || null,
    status: (txt.match(/Status\s+(.+?)\s+(?:Vendedor|Segundo|Comprovante|Detalhar|Nome)/i) || [])[1] || null,
  };
  if (!dados.codigo) return null; // reserva nao encontrada
  const servBloco = txt.slice(txt.indexOf("Serviços"));
  dados.servicos = [];
  const re = /\b(IN|OUT|TOUR|TRANSFER)\b[^]*?Regular\s+(\d{2}\/\d{2}\/\d{4})\s+([A-Z0-9]{1,3}\s*-\s*\d{2,4})\s+(\d{2}:\d{2}:\d{2})/g;
  let m;
  while ((m = re.exec(servBloco)) !== null) {
    dados.servicos.push({ tipo: m[1], data: m[2], voo: m[3].replace(/\s+/g,""), horario: m[4].slice(0,5) });
    if (dados.servicos.length > 10) break;
  }
  return dados;
}

async function lerEscalaDoDia(dataIso, jar) {
  const q = `/management-reports/scale?ScaleSummarySearch[date]=${dataIso}`
    + `&ScaleSummarySearch[driver_id]=&ScaleSummarySearch[_guide_id]=`
    + `&ScaleSummarySearch[vehicle_id]=&ScaleSummarySearch[service_id]=&ScaleSummarySearch[service_type]=`;
  const html = await getText(q, jar);
  const linhas = [];
  const trs = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const tr of trs) {
    const cols = (tr.match(/<td[\s\S]*?<\/td>/gi) || []).map(td => soTexto(td));
    if (cols.length < 8) continue;
    const texto = cols.join(" | ");
    const ro = (texto.match(/RO-[A-Z]{2,5}-\d{3,5}/) || [])[0];
    if (!ro) continue;
    const idxRo = cols.findIndex(c => /RO-[A-Z]{2,5}-\d/.test(c));
    const c = (n) => (cols[idxRo + n] || "").trim();
    const tipo = (texto.match(/\b(IN|OUT|TOUR|TRANSFER)\b/) || [])[0] || null;
    const horas = texto.match(/\d{2}:\d{2}/g) || [];
    linhas.push({
      escala: ro, veiculo: c(3), motorista: c(7),
      guia: (c(8) && c(8) !== "-") ? c(8).replace(/\s*-\s*GUIA\s*$/i,"").trim() : null,
      tipo, inicio: horas[0] || null,
    });
  }
  return linhas;
}

// Consulta completa por numero de reserva. Retorna o texto formatado.
async function consultarReserva(numero, email, senha) {
  const jar = await login(email, senha);
  const r = await lerReserva(numero, jar);
  if (!r) return `Não encontrei a reserva REC-${numero}. Confira o número.`;

  const cache = {};
  for (const sv of r.servicos) {
    const [d,m,a] = sv.data.split("/");
    const dataIso = `${a}-${m}-${d}`;
    if (!cache[dataIso]) { try { cache[dataIso] = await lerEscalaDoDia(dataIso, jar); } catch { cache[dataIso] = []; } }
    let cand = cache[dataIso].filter(l => l.tipo === sv.tipo);
    if (cand.length > 1 && sv.horario) { const p = cand.filter(l => l.inicio === sv.horario); if (p.length) cand = p; }
    sv.escala = cand[0] || null;
  }

  let txt = `📋 *${r.codigo}*\n`;
  txt += `👤 ${r.cliente || "-"}\n`;
  if (r.telefone) txt += `📞 ${r.telefone}\n`;
  if (r.idioma) txt += `🗣️ ${r.idioma}\n`;
  txt += `📌 ${r.status || "-"}\n`;
  if (r.observacao) txt += `📝 ${r.observacao}\n`;
  for (const sv of r.servicos) {
    txt += `\n✈️ *${sv.tipo}* ${sv.data} — voo ${sv.voo} ${sv.horario}\n`;
    if (sv.escala) {
      txt += `🚐 Motorista: ${sv.escala.motorista || "-"} | ${sv.escala.veiculo || "-"}\n`;
      txt += `🧭 Guia: ${sv.escala.guia || "(sem guia)"}\n`;
    } else {
      txt += `_ainda não escalado_\n`;
    }
  }
  return txt.trim();
}

module.exports = { consultarReserva };
