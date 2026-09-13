// Public configuration. Both of these values are meant to be visible in the
// browser -- the anon key grants nothing on its own, because every table is
// protected by row level security. Secrets (the Anthropic key, the GitHub
// token, the service role key) live only in Supabase Edge Function secrets
// and must never appear in this file.
export const CONFIG = {
  supabaseUrl: "https://strqudnflohtwsmxqtpv.supabase.co",
  supabaseAnonKey: "sb_publishable_1bqmnW-HJRrcxhIcudY6lA__xD0hTng",
};
