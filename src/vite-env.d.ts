/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_WHATSAPP_DAILY_CAP?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
