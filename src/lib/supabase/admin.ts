import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Admin (service-role) Supabase client.
 * - Bypasses Row Level Security.
 * - Server-only — NEVER import from client code or /app pages that render client-side.
 * - Used by: seed scripts, daily cron, operator actions, raffle draw.
 */
export function adminClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRole) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env. Check .env.local.",
    );
  }

  return createClient(url, serviceRole, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
