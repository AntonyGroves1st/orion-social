/// <reference types="vite/client" />

declare const __ORION_BUILD__: string

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string
  readonly VITE_SUPABASE_ANON_KEY: string
  readonly VITE_STRIPE_PUBLISHABLE_KEY?: string
  readonly VITE_ORION_PAYMENTS_URL?: string
  /** Public web URL for live-room invite links (not 127.0.0.1). */
  readonly VITE_PUBLIC_APP_URL?: string
}
