// ============================================================================
// /api/send-booking-email.js
// Vercel Serverless Function
//
// Invia le email transazionali relative alle prenotazioni (confermata,
// rifiutata, modificata, annullata) tramite Gmail SMTP — stessa
// configurazione e stessa grafica già usate per il recupero password
// (vedi /api/request-password-reset.js). Nessuna di queste email passa da
// Supabase.
//
// Body atteso:
// {
//   tipo: "confermata" | "rifiutata" | "modificata" | "annullata",
//   email: "cliente@example.com",
//   nomeCliente: "Mario",
//   prenotazione: { data, orario, servizio, comune, via }  // opzionale
// }
// ============================================================================

const nodemailer = require("nodemailer");

const SITE_URL = process.env.SITE_URL || "https://barber-lc.vercel.app";
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const TIPI_VALIDI = ["confermata", "rifiutata", "modificata", "annullata"];

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", SITE_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito." });
  }

  try {
    const { tipo, email, nomeCliente, prenotazione } = req.body || {};

    if (!TIPI_VALIDI.includes(tipo)) {
      return res.status(400).json({ error: "Tipo di notifica non valido." });
    }
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Email non valida." });
    }

    const nome = (nomeCliente && String(nomeCliente).trim()) || "Cliente";
    const { subject, html } = buildEmail(tipo, { nome, prenotazione: prenotazione || {} });

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"Barber LC" <${GMAIL_USER}>`,
      to: email.trim().toLowerCase(),
      subject,
      html,
    });

    return res.status(200).json({ sent: true });
  } catch (err) {
    console.error("[send-booking-email]", err);
    return res.status(500).json({ error: "Errore interno del server." });
  }
};

/* --------------------------------------------------------------------------
   Costruzione oggetto + corpo HTML in base al tipo di notifica
   -------------------------------------------------------------------------- */
function buildEmail(tipo, { nome, prenotazione }) {
  switch (tipo) {
    case "confermata":
      return {
        subject: "✅ Prenotazione confermata - Barber LC",
        html: wrapEmail({
          title: "Prenotazione confermata",
          accentColor: "#7fce93",
          intro: `Ciao ${escapeHtml(nome)}, la tua prenotazione è stata confermata. Ti aspettiamo!`,
          details: bookingDetailsTable(prenotazione),
          ctaLabel: "Vai all'Area Clienti",
          ctaLink: `${SITE_URL}#area-cliente`,
        }),
      };
    case "rifiutata":
      return {
        subject: "❌ Prenotazione rifiutata - Barber LC",
        html: wrapEmail({
          title: "Prenotazione rifiutata",
          accentColor: "#e08b85",
          intro: `Ciao ${escapeHtml(nome)}, siamo spiacenti ma non è stato possibile confermare la tua richiesta di prenotazione. Scegli pure un altro giorno o orario disponibile: saremo felici di accoglierti.`,
          details: "",
          ctaLabel: "Prenota un nuovo appuntamento",
          ctaLink: `${SITE_URL}#prenota`,
        }),
      };
    case "modificata":
      return {
        subject: "✏️ Prenotazione modificata - Barber LC",
        html: wrapEmail({
          title: "Prenotazione aggiornata",
          accentColor: "#c9a35c",
          intro: `Ciao ${escapeHtml(nome)}, la tua prenotazione è stata aggiornata con i nuovi dati qui sotto ed è di nuovo in attesa di conferma da parte nostra.`,
          details: bookingDetailsTable(prenotazione),
          ctaLabel: "Vai all'Area Clienti",
          ctaLink: `${SITE_URL}#area-cliente`,
        }),
      };
    case "annullata":
      return {
        subject: "🚫 Prenotazione annullata - Barber LC",
        html: wrapEmail({
          title: "Prenotazione annullata",
          accentColor: "#a3a39c",
          intro: `Ciao ${escapeHtml(nome)}, confermiamo che la tua prenotazione è stata annullata. Se desideri, puoi prenotare un nuovo appuntamento quando vuoi.`,
          details: "",
          ctaLabel: "Prenota un nuovo appuntamento",
          ctaLink: `${SITE_URL}#prenota`,
        }),
      };
  }
}

function bookingDetailsTable({ data, orario, servizio, comune, via } = {}) {
  const rows = [
    ["Data", formatDataIT(data)],
    ["Orario", orario],
    ["Servizio", servizio],
    ["Comune", comune],
    ["Via", via],
  ].filter(([, value]) => !!value);

  if (!rows.length) return "";

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows
        .map(
          ([label, value]) => `
        <tr>
          <td style="padding:8px 0;color:#5c5c57;font-size:12px;text-transform:uppercase;letter-spacing:0.04em;width:100px;vertical-align:top;">${escapeHtml(label)}</td>
          <td style="padding:8px 0;color:#f6f5f1;font-size:14px;">${escapeHtml(String(value))}</td>
        </tr>`
        )
        .join("")}
    </table>`;
}

function formatDataIT(isoDate) {
  if (!isoDate) return "";
  try {
    const d = new Date(`${isoDate}T00:00:00`);
    return d.toLocaleDateString("it-IT", { day: "2-digit", month: "long", year: "numeric" });
  } catch {
    return isoDate;
  }
}

/* --------------------------------------------------------------------------
   Wrapper HTML — stessa grafica Barber LC dell'email di recupero password
   -------------------------------------------------------------------------- */
function wrapEmail({ title, intro, details, ctaLabel, ctaLink, accentColor }) {
  return `<!doctype html>
<html lang="it">
  <body style="margin:0;padding:0;background:#08080a;font-family:Arial,Helvetica,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#08080a;padding:40px 0;">
      <tr>
        <td align="center">
          <table width="100%" style="max-width:480px;background:#17171b;border:1px solid rgba(201,163,92,0.4);border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:36px 36px 8px;text-align:center;">
                <div style="font-family:Georgia,serif;font-size:22px;font-weight:bold;color:#f6f5f1;">
                  Barber <span style="color:#c9a35c;">LC</span>
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 36px 0;">
                <h1 style="font-family:Georgia,serif;font-size:21px;color:${accentColor};margin:0 0 16px;text-align:center;">${escapeHtml(title)}</h1>
                <p style="color:#a3a39c;font-size:15px;line-height:1.6;margin:0 0 24px;text-align:center;">
                  ${intro}
                </p>
                ${details ? `<div style="padding:18px 20px;background:#131315;border:1px solid rgba(201,163,92,0.16);border-radius:12px;margin:0 0 28px;">${details}</div>` : ""}
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 36px;text-align:center;">
                <a href="${ctaLink}" style="display:inline-block;padding:15px 34px;background:linear-gradient(135deg,#ecd6a4,#9c7c3f);color:#08080a;font-weight:bold;font-size:15px;text-decoration:none;border-radius:999px;">
                  ${escapeHtml(ctaLabel)}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 30px;text-align:center;">
                <p style="color:#5c5c57;font-size:12px;line-height:1.6;margin:0;">
                  Barber LC — il tuo barbiere a domicilio a Lecco e provincia.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
