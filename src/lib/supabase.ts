import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  throw new Error(
    "Faltan las variables VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY. " +
      "Copiá .env.example a .env y completá los valores del panel de Supabase.",
  );
}

export const supabase = createClient(url, key, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
