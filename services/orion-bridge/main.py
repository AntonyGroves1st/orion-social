"""
Local Orion Key bridge — calls the `orion-key` Python package beside `orion-social/`.
Runs on http://127.0.0.1:8790 — use from the web UI for sealing/unsealing bodies.

Do not expose this raw on the internet; bind localhost only or put behind TLS + auth.
"""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

_ROOT = Path(__file__).resolve().parents[3]  # F:\...\socialmedia G
_ORION_SRC = _ROOT / "orion-key" / "src"
if _ORION_SRC.is_dir():
    sys.path.insert(0, str(_ORION_SRC))
else:
    raise RuntimeError(f"Missing orion-key src at {_ORION_SRC}")

from orion_key.astro import Observer, compute_orion_signature, orion_signature_from_payload_dict
from orion_key.crypto import decode_payload, derive_key, encode_payload
from orion_key.protocol import KDF_PROFILE_V1, KDF_PROFILE_V2_ARGON2ID

app = FastAPI(title="Orion Social — Orion Key bridge")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5732",
        "http://localhost:5732",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(status_code=204)


@app.get("/")
def root():
    """Browser-friendly index — `/` had no handler before (404). APIs are under `/health` and `/v1/*`."""
    return {
        "service": "Orion Social — Orion Key bridge",
        "ok": True,
        "interactive_docs": "/docs",
        "endpoints": {
            "health": {"method": "GET", "path": "/health"},
            "seal": {"method": "POST", "path": "/v1/seal"},
            "open": {"method": "POST", "path": "/v1/open"},
        },
        "vite_proxy": "From the web app, requests go to http://localhost:5732/orion/v1/… → this server.",
        "orion_key_src": str(_ORION_SRC),
    }


class SealRequest(BaseModel):
    plaintext: str
    lat: float
    lon: float
    elevation_m: float = 0.0
    timestamp_utc_iso: str = Field(description="UTC instant e.g. 2026-02-09T18:30:00+00:00")
    secret: str = ""
    kdf_profile: str = KDF_PROFILE_V1


class OpenRequest(BaseModel):
    token: str
    secret: str


@app.get("/health")
def health():
    return {"ok": True, "orion_key_src": str(_ORION_SRC)}


@app.post("/v1/seal")
def seal(req: SealRequest):
    kp = req.kdf_profile
    if kp not in (KDF_PROFILE_V1, KDF_PROFILE_V2_ARGON2ID):
        raise HTTPException(400, detail=f"unsupported kdf_profile {kp}")
    dt = datetime.fromisoformat(req.timestamp_utc_iso.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    obs = Observer(lat=req.lat, lon=req.lon, elevation_m=req.elevation_m)
    sig = compute_orion_signature(dt.astimezone(timezone.utc), obs, kdf_profile=kp)
    key = derive_key(sig, req.secret)
    tok = encode_payload(req.plaintext, key, sig)
    return {"token": tok}


@app.post("/v1/open")
def open_token(req: OpenRequest):
    import base64
    import json

    raw = base64.urlsafe_b64decode(req.token.strip().encode("ascii"))
    outer = json.loads(raw.decode("utf-8"))
    sigd = outer.get("sig") or outer.get("Sig")
    if not sigd:
        raise HTTPException(400, detail="token missing embedded sky signature")
    sig = orion_signature_from_payload_dict(sigd)
    kp = getattr(sig, "kdf_profile", KDF_PROFILE_V1)
    if kp == KDF_PROFILE_V2_ARGON2ID and not (req.secret or "").strip():
        raise HTTPException(400, detail="v2-argon2id requires secret")
    key = derive_key(sig, req.secret)
    pt = decode_payload(req.token, key, sig)
    return {"plaintext": pt}


def main():
    import uvicorn

    # Must pass `app` here: this file runs as __main__; `uvicorn.run("main:app")` imports another `main` from sys.path.
    print(f"[orion-bridge] starting | {Path(__file__).resolve()}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=8790, log_level="info")


if __name__ == "__main__":
    main()
