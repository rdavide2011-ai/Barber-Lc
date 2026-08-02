// ============================================================================
// Supabase Edge Function: reset-password-request
//
// Riceve { email } dal sito Barber LC e:
//  1. verifica LATO SERVER (con la service role key, mai esposta al client)
//     se esiste un account con quella email, interrogando la tabella
//     "profili" — le policy RLS impediscono al client di farlo direttamente;
//  2. se l'account NON esiste: non invia nulla, risponde { exists: false };
//  3. se l'account esiste: usa il meccanismo nativo di Supabase Auth
//     (resetPasswordForEmail) per generare un link di recupero temporaneo
//     e sicuro e per inviarlo via email, poi risponde { exists: true }.
//
// Nessuna password o dato sensibile transita da questa funzione: il reset
// vero e proprio avviene sulla pagina /#... del sito con il token che
// Supabase gestisce internamente (auth.updateUser).
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY sono iniettate
// automaticamente da Supabase in ogni Edge Function: non serve impostarle
// come secrets. SITE_URL invece va impostato manualmente (vedi istruzioni).
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://barber-lc.vercel.app";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { email } = await req.json();

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return new Response(JSON.stringify({ error: "Email non valida." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    const supabaseAdmin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Controllo reale, lato server, sulla tabella "profili" (colonna email
    // già popolata in fase di registrazione). Il client non ha accesso a
    // questa query: solo questa funzione, con la service role key, può
    // farla bypassando le policy RLS.
    const { data: profilo, error: profiloError } = await supabaseAdmin
      .from("profili")
      .select("id")
      .ilike("email", normalizedEmail)
      .maybeSingle();

    if (profiloError) throw profiloError;

    if (!profilo) {
      return new Response(JSON.stringify({ exists: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // L'account esiste: Supabase genera un token di recupero temporaneo e
    // invia l'email tramite il template "Reset Password" configurato nel
    // progetto. Al click, l'utente viene rimandato a SITE_URL con il token
    // nell'URL: la SPA intercetta l'evento PASSWORD_RECOVERY e mostra la
    // pagina di reset personalizzata.
    const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(
      normalizedEmail,
      { redirectTo: SITE_URL }
    );
    if (resetError) throw resetError;

    return new Response(JSON.stringify({ exists: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[reset-password-request]", err);
    return new Response(JSON.stringify({ error: "Errore interno del server." }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
