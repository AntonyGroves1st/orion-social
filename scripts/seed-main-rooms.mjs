#!/usr/bin/env node
/** Deploy schema + seed 10 main lobby rooms via Supabase REST (anon key). */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, 'web', '.env')

function loadEnv() {
  try {
    const raw = readFileSync(envPath, 'utf8')
    const out = {}
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) out[m[1]] = m[2].trim()
    }
    return out
  } catch {
    return {}
  }
}

const env = loadEnv()
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY
if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in web/.env')
  process.exit(1)
}

const sqlPath = resolve(root, 'supabase', 'RUN_SEED_MAIN_LIVE_ROOMS.sql')
const sql = readFileSync(sqlPath, 'utf8')

async function runSql() {
  const res = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (res.ok) return res.json()

  const rpc = await fetch(`${url}/rest/v1/rpc/reset_and_seed_main_live_rooms`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ p_admin_secret: 'orion-main-rooms-2026' }),
  })
  const body = await rpc.text()
  if (!rpc.ok) {
    console.error('Seed failed:', rpc.status, body)
    console.error('\nRun supabase/RUN_SEED_MAIN_LIVE_ROOMS.sql in Dashboard → SQL Editor first.')
    process.exit(1)
  }
  console.log('Main live rooms seeded:')
  console.log(body)
}

void runSql()
