// ============================================================================
// /api/send-booking-email.js
// Vercel Serverless Function
//
// Invia le email transazionali relative alle prenotazioni (confermata,
// rifiutata, modificata, annullata) tramite Gmail SMTP — stessa
// configurazione e stessa grafica già usate per il recupero password
// (vedi /api/request-password-reset.js). Nessuna di queste email passa da
// Supabase per l'invio, ma il PROFILO del cliente (email, nome) può essere
// recuperato qui, lato server, con la SUPABASE_SERVICE_ROLE_KEY.
//
// Perché serve: le RLS sulla tabella "profili" permettono a ciascun utente
// di leggere solo la propria riga. Quando è l'ADMIN a confermare/rifiutare
// la prenotazione di un altro utente, il browser non può leggere il
// profilo del cliente — e non deve, perché non vogliamo allentare le RLS.
// Il fix corretto è: il browser passa solo "utente_id", e questa function
// (che gira lato server con la service role key, quindi bypassa le RLS)
// recupera email e nome direttamente da Supabase.
//
// Body atteso — DUE modalità, entrambe supportate:
//
// 1) Il chiamante conosce già email/nome (es. l'utente agisce sulla
//    propria prenotazione: creazione, modifica, annullamento):
// {
//   tipo: "confermata" | "rifiutata" | "modificata" | "annullata",
//   email: "cliente@example.com",
//   nomeCliente: "Mario",
//   prenotazione: { data, orario, servizio, comune, via }  // opzionale
// }
//
// 2) L'admin conferma/rifiuta la prenotazione di un altro utente e passa
//    solo l'id, senza aver mai letto "profili" dal browser:
// {
//   tipo: "confermata" | "rifiutata",
//   utente_id: "uuid-del-cliente",
//   prenotazione: { data, orario, servizio, comune, via }  // opzionale
// }
// In questo caso email e nome vengono recuperati qui da "profili" con la
// service role key.
// ============================================================================

const nodemailer = require("nodemailer");
const { createClient } = require("@supabase/supabase-js");

const SITE_URL = process.env.SITE_URL || "https://barber-lc.vercel.app";
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TIPI_VALIDI = ["confermata", "rifiutata", "modificata", "annullata"];

// Client Supabase con la service role key: bypassa le RLS, va usato SOLO
// lato server (mai esposto al browser) e SOLO per questo lookup puntuale.
let supabaseAdmin = null;
function getSupabaseAdmin() {
  if (!supabaseAdmin) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY mancanti nelle env vars.");
    }
    supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return supabaseAdmin;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", SITE_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito." });
  }

  try {
    const { tipo, email, nomeCliente, utente_id, prenotazione } = req.body || {};

    if (!TIPI_VALIDI.includes(tipo)) {
      return res.status(400).json({ error: "Tipo di notifica non valido." });
    }
    if (!email && !utente_id) {
      return res.status(400).json({ error: "Serve 'email' oppure 'utente_id'." });
    }

    // Email e nome finali da usare per l'invio: partono da quanto passato
    // dal client, e vengono completati/recuperati da Supabase se manca
    // l'email diretta ma è presente utente_id.
    let emailFinale = email;
    let nomeFinale = nomeCliente;

    if (!emailFinale) {
      if (typeof utente_id !== "string" || !utente_id.trim()) {
        return res.status(400).json({ error: "utente_id non valido." });
      }

      const { data: profilo, error: erroreProfilo } = await getSupabaseAdmin()
        .from("profili")
        .select("email, nome")
        .eq("id", utente_id)
        .single();

      if (erroreProfilo || !profilo) {
        console.error("[send-booking-email] profilo non trovato per utente_id:", utente_id, erroreProfilo);
        return res.status(404).json({ error: "Profilo cliente non trovato." });
      }

      emailFinale = profilo.email;
      nomeFinale = profilo.nome || nomeFinale;
    }

    if (!emailFinale || typeof emailFinale !== "string" || !emailFinale.includes("@")) {
      return res.status(400).json({ error: "Email non valida." });
    }

    const nome = (nomeFinale && String(nomeFinale).trim()) || "Cliente";
    const { subject, html } = buildEmail(tipo, { nome, prenotazione: prenotazione || {} });

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"Barber LC" <${GMAIL_USER}>`,
      to: emailFinale.trim().toLowerCase(),
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
