#!/usr/bin/env pwsh
# Applies invite RPC SQL to YOUR linked hosted Supabase project (not something an agent can do without your login).
#
# Prerequisites (once):
#   1) npx supabase login
#   2) npx supabase link --project-ref <your-ref-from-URL>
#       Example: URL https://abcdefgh.supabase.co  →  ref = abcdefgh
#
# Then run:
#   .\Apply-Invite-RPC-Fix.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$fix = Join-Path $root 'supabase\FIX_CLAIM_INVITE_RPC_ONLY.sql'
if (-not (Test-Path $fix)) {
  throw "Missing $fix"
}

Write-Host '[Orion Social] Applying supabase/FIX_CLAIM_INVITE_RPC_ONLY.sql to linked remote project…' -ForegroundColor Cyan

npx --yes supabase@latest db query -f $fix --linked -o table

Write-Host ''
Write-Host 'Verify (optional):' -ForegroundColor Cyan
Write-Host ('  npx supabase db query -f "{0}" --linked -o table' -f (Join-Path $root 'supabase\VERIFY_CLAIM_INVITE_RPC.sql'))
