// ============================================================================
// /api/request-password-reset.js
// Vercel Serverless Function
//
// 1. Riceve { email } dal sito.
// 2. Verifica LATO SERVER, con la service_role key di Supabase (mai esposta
//    al browser), se esiste un account con quell'email nella tabella
//    "profili".
// 3. Se NON esiste: risponde { exists: false }. Nessuna email viene inviata.
// 4. Se esiste: usa supabaseAdmin.auth.admin.generateLink() per generare un
//    link di recupero temporaneo e sicuro (gestito internamente da Supabase
//    Auth) SENZA far inviare l'email a Supabase, e spedisce invece
//    un'email brandizzata Barber LC tramite Gmail SMTP, dall'indirizzo
//    barberlc.prenotazioni@gmail.com.
//
// Nessun segreto (service_role, password Gmail) è mai presente nel codice
// del sito: vive solo qui, lato server, letto da variabili d'ambiente di
// Vercel.
// ============================================================================

const { createClient } = require("@supabase/supabase-js");
const nodemailer = require("nodemailer");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = process.env.SITE_URL || "https://barber-lc.vercel.app";
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", SITE_URL);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo non consentito." });
  }

  try {
    const { email } = req.body || {};
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Email non valida." });
    }
    const normalizedEmail = email.trim().toLowerCase();

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Controllo reale, lato server, sulla tabella "profili". Le policy RLS
    // impediscono al client di eseguire questa query: solo questa funzione,
    // con la service_role key, può bypassarle.
    const { data: profilo, error: profiloError } = await supabaseAdmin
      .from("profili")
      .select("id, nome")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (profiloError) throw profiloError;

    if (!profilo) {
      return res.status(200).json({ exists: false });
    }

    // Genera il link di recupero: Supabase Auth crea e gestisce il token
    // temporaneo e sicuro (stesso meccanismo nativo di sempre), ma NON
    // invia alcuna email — ci pensiamo noi qui sotto con Gmail.
    const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: normalizedEmail,
      options: { redirectTo: SITE_URL },
    });
    if (linkError) throw linkError;

    // NON usiamo linkData.properties.action_link: punterebbe direttamente
    // all'endpoint /auth/v1/verify di Supabase, che consuma il token con una
    // semplice richiesta GET. Molti scanner di sicurezza email (incluso
    // quello di Gmail) "pre-visitano" automaticamente ogni link ricevuto per
    // controllarne la sicurezza: questo consuma il token PRIMA che l'utente
    // clicchi davvero, causando l'errore "otp_expired" anche su un link
    // appena inviato.
    //
    // Costruiamo invece un link che punta al NOSTRO sito con il token_hash
    // come parametro: il token viene verificato solo quando il sito esegue
    // lato client supabase.auth.verifyOtp() (una POST esplicita), non da una
    // GET automatica di uno scanner.
    const hashedToken = linkData?.properties?.hashed_token;
    if (!hashedToken) throw new Error("Token di recupero non generato.");
    const actionLink = `${SITE_URL}?token_hash=${encodeURIComponent(hashedToken)}&type=recovery`;

    const nomeCliente = profilo.nome || "Cliente";

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporter.sendMail({
      from: `"Barber LC" <${GMAIL_USER}>`,
      to: normalizedEmail,
      subject: "Recupero password — Barber LC",
      html: buildEmailHtml({ nomeCliente, actionLink }),
    });

    return res.status(200).json({ exists: true });
  } catch (err) {
    console.error("[request-password-reset]", err);
    return res.status(500).json({ error: "Errore interno del server." });
  }
};

function buildEmailHtml({ nomeCliente, actionLink }) {
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
              <td style="padding:20px 36px 0;text-align:center;">
                <h1 style="font-family:Georgia,serif;font-size:22px;color:#f6f5f1;margin:0 0 16px;">Reimposta la tua password</h1>
                <p style="color:#a3a39c;font-size:15px;line-height:1.6;margin:0 0 28px;">
                  Ciao ${escapeHtml(nomeCliente)}, abbiamo ricevuto una richiesta di reimpostazione della password per il tuo account Barber LC. Clicca sul pulsante qui sotto per scegliere una nuova password.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 28px;text-align:center;">
                <a href="${actionLink}" style="display:inline-block;padding:15px 34px;background:linear-gradient(135deg,#ecd6a4,#9c7c3f);color:#08080a;font-weight:bold;font-size:15px;text-decoration:none;border-radius:999px;">
                  Reimposta password
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 36px;text-align:center;">
                <p style="color:#5c5c57;font-size:12px;line-height:1.6;margin:0;">
                  Se non hai richiesto tu il recupero password, ignora pure questa email: la tua password attuale resterà invariata. Il link scade dopo un breve periodo di tempo per motivi di sicurezza.
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
