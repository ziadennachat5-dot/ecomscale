// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── WhatsApp Webhook Handler ─────────────────────────────────────────────────────
// This edge function handles:
//   1. GET requests for webhook verification from Meta
//   2. POST requests for incoming WhatsApp messages
//   3. AI-powered responses using Gemini API
//   4. Sending replies back via WhatsApp Cloud API
// ─────────────────────────────────────────────────────────────────────────────────────

serve(async (req) => {
  // ── CORS preflight ───────────────────────────────────────────────────────────────
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const WHATSAPP_VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
  const WHATSAPP_ACCESS_TOKEN = Deno.env.get("WHATSAPP_ACCESS_TOKEN")!;
  const WHATSAPP_PHONE_NUMBER_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")!;
  const META_APP_SECRET = Deno.env.get("META_APP_SECRET")!;

  // Create Supabase client
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ── GET: Webhook Verification ────────────────────────────────────────────────────
  if (req.method === "GET") {
    const url = new URL(req.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    console.log("[WhatsApp Webhook] Verification request:", { mode, token, hasChallenge: !!challenge });

    if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN && challenge) {
      console.log("[WhatsApp Webhook] Verification successful");
      // Return the challenge as plain text (not JSON) as required by Meta
      return new Response(challenge, { status: 200 });
    }

    console.log("[WhatsApp Webhook] Verification failed");
    return new Response("Forbidden", { status: 403 });
  }

  // ── POST: Incoming Message Processing ────────────────────────────────────────────
  if (req.method === "POST") {
    try {
      // Verify HMAC signature before processing
      const signatureHeader = req.headers.get("x-hub-signature-256");
      if (!signatureHeader) {
        console.error("[WhatsApp Webhook] Missing X-Hub-Signature-256 header");
        return new Response(JSON.stringify({ error: "Unauthorized: Missing signature" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      // Read raw body for signature verification (must be done before JSON parsing)
      const rawBody = await req.text();
      
      // Verify signature
      const isValid = await verifyHmacSignature(rawBody, signatureHeader, META_APP_SECRET);
      if (!isValid) {
        console.error("[WhatsApp Webhook] Invalid HMAC signature");
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid signature" }), {
          status: 401,
          headers: corsHeaders,
        });
      }

      // Parse JSON after signature verification
      const payload = JSON.parse(rawBody);
      console.log("[WhatsApp Webhook] Received payload:", JSON.stringify(payload, null, 2));

      // Extract message from Meta's webhook structure
      const entry = payload.entry?.[0];
      if (!entry) {
        console.log("[WhatsApp Webhook] No entry in payload");
        return new Response(JSON.stringify({ received: true }), { headers: corsHeaders });
      }

      const changes = entry.changes?.[0];
      if (!changes) {
        console.log("[WhatsApp Webhook] No changes in entry");
        return new Response(JSON.stringify({ received: true }), { headers: corsHeaders });
      }

      const value = changes.value;
      if (!value || !value.messages) {
        console.log("[WhatsApp Webhook] No messages in value");
        return new Response(JSON.stringify({ received: true }), { headers: corsHeaders });
      }

      const message = value.messages[0];
      if (!message) {
        console.log("[WhatsApp Webhook] No message object");
        return new Response(JSON.stringify({ received: true }), { headers: corsHeaders });
      }

      // Extract sender phone number and message text
      const from = message.from; // Customer's phone number
      const text = message.text?.body; // Message content
      const messageId = message.id;

      console.log("[WhatsApp Webhook] Processing message:", { from, text, messageId });

      if (!text) {
        console.log("[WhatsApp Webhook] No text content in message");
        return new Response(JSON.stringify({ received: true }), { headers: corsHeaders });
      }

      // ── Workspace Resolution (HARDCODED FOR TESTING) ───────────────────────────────
      // TODO: Implement multi-tenant resolution using whatsapp_credentials table
      // For now, we'll use the first workspace we find
      const { data: workspaces, error: wsError } = await supabase
        .from("workspaces")
        .select("id, name")
        .limit(1);

      if (wsError || !workspaces || workspaces.length === 0) {
        console.error("[WhatsApp Webhook] No workspace found");
        return new Response(JSON.stringify({ received: true, error: "No workspace found" }), { 
          headers: corsHeaders 
        });
      }

      const workspace = workspaces[0];
      console.log("[WhatsApp Webhook] Using workspace:", workspace.id, workspace.name);

      // ── Check if this is the first message from this phone number ──────────────────
      const { data: existingContact, error: contactError } = await supabase
        .from("whatsapp_contacts")
        .select("id")
        .eq("phone_number", from)
        .eq("workspace_id", workspace.id)
        .single();

      const isFirstTime = !existingContact;

      if (isFirstTime) {
        // First time contact: insert record and send welcome message
        console.log("[WhatsApp Webhook] First-time contact, sending welcome message");
        
        const { error: insertError } = await supabase
          .from("whatsapp_contacts")
          .insert({
            phone_number: from,
            workspace_id: workspace.id,
          });

        if (insertError) {
          console.error("[WhatsApp Webhook] Failed to insert contact:", insertError);
        }

        const welcomeMessage = "Bienvenue chez ecomOS ! 👋 Merci de nous contacter — notre équipe revient vers vous rapidement.";
        
        await sendWhatsAppMessage(from, welcomeMessage, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN);
        console.log("[WhatsApp Webhook] Welcome message sent");
      } else {
        // Repeat contact: just log, no reply
        console.log("[WhatsApp Webhook] Repeat contact, no automated reply sent");
      }

      return new Response(JSON.stringify({ received: true, isFirstTime }), { 
        headers: corsHeaders 
      });

    } catch (error: any) {
      console.error("[WhatsApp Webhook] Error processing message:", error);
      return new Response(JSON.stringify({ received: true, error: error.message }), { 
        headers: corsHeaders 
      });
    }
  }

  // ── Method Not Allowed ────────────────────────────────────────────────────────────
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: corsHeaders,
  });
});

// ─── Helper Functions ───────────────────────────────────────────────────────────────

// Verify HMAC-SHA256 signature for Meta webhooks (constant-time comparison)
async function verifyHmacSignature(
  body: string,
  signatureHeader: string,
  secret: string
): Promise<boolean> {
  try {
    // Extract the signature value (remove "sha256=" prefix)
    const expectedSignature = signatureHeader.replace("sha256=", "");
    
    // Compute HMAC-SHA256 of the body
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    
    const signature = await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(body)
    );
    
    // Convert to hex string
    const signatureArray = Array.from(new Uint8Array(signature));
    const signatureHex = signatureArray
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    
    // Constant-time comparison
    return constantTimeCompare(signatureHex, expectedSignature);
  } catch (error) {
    console.error("[WhatsApp Webhook] Signature verification error:", error);
    return false;
  }
}

// Constant-time comparison to prevent timing attacks
function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  
  return result === 0;
}

async function sendWhatsAppMessage(
  to: string,
  text: string,
  phoneNumberId: string,
  accessToken: string
): Promise<void> {
  const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
  
  const payload = {
    messaging_product: "whatsapp",
    to: to,
    text: {
      body: text,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`WhatsApp API failed (${response.status}): ${error}`);
  }

  console.log("[WhatsApp Webhook] Message sent via API:", await response.json());
}