#!/usr/bin/env python3
"""
AIR3 High-Performance Bilingual Neural TTS Server
Powered by Kyutai Pocket-TTS (Italian + English) on NVIDIA CUDA.
Provides an OpenAI-compatible /v1/audio/speech endpoint.
"""

import io
import os
import sys
import time
import logging
import threading
from typing import Optional, List, Dict, Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, HTMLResponse
from pydantic import BaseModel, Field

from pocket_tts.models.tts_model import TTSModel
from pocket_tts.default_parameters import get_default_voice_for_language
from pocket_tts.data.audio import stream_audio_chunks

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("air3-tts")

HOST = os.environ.get("AIR3_TTS_HOST", "0.0.0.0")
PORT = int(os.environ.get("AIR3_TTS_PORT", "8880"))
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

app = FastAPI(
    title="AIR3 Neural TTS Server",
    description="High-Speed Bilingual (IT/EN) OpenAI-compatible speech synthesis for AIR3 Live",
    version="2.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class UnclosableBytesIO(io.BytesIO):
    """Prevent stream_audio_chunks from closing the BytesIO buffer on exit."""
    def close(self):
        pass

# Global models and precomputed voice states
models: Dict[str, TTSModel] = {}
voice_states: Dict[str, Any] = {}
generation_lock = threading.Lock()

def init_models():
    logger.info(f"Initializing bilingual Pocket-TTS models on {DEVICE}...")
    t0 = time.time()
    
    # Italian model
    logger.info("Loading Italian model (giovanni)...")
    model_it = TTSModel.load_model(language="italian")
    model_it.to(DEVICE)
    voice_it = model_it.get_state_for_audio_prompt(get_default_voice_for_language("italian", None))
    models["it"] = model_it
    voice_states["it"] = voice_it
    voice_states["giovanni"] = voice_it
    voice_states["if_sara"] = voice_it
    
    # English model
    logger.info("Loading English model (alba)...")
    model_en = TTSModel.load_model(language="english")
    model_en.to(DEVICE)
    voice_en = model_en.get_state_for_audio_prompt(get_default_voice_for_language("english", None))
    models["en"] = model_en
    voice_states["en"] = voice_en
    voice_states["alba"] = voice_en
    voice_states["af_jessica"] = voice_en
    
    vram_mb = torch.cuda.memory_allocated() / (1024 * 1024) if DEVICE == "cuda" else 0
    logger.info(f"Models loaded successfully in {time.time()-t0:.2f}s! VRAM allocated: {vram_mb:.1f} MB")

class SpeechRequest(BaseModel):
    input: str = Field(..., description="Text to synthesize")
    model: Optional[str] = Field("pocket-tts", description="Model name")
    voice: Optional[str] = Field("if_sara", description="Voice ID or language code (e.g. if_sara, giovanni, af_jessica, alba, it, en)")
    speed: Optional[float] = Field(1.0, ge=0.5, le=2.0, description="Speech rate")
    response_format: Optional[str] = Field("wav", description="Audio format (wav)")

def detect_language(text: str, requested_voice: str) -> str:
    """Determine whether to use Italian or English model based on voice or text heuristics."""
    voice_lower = (requested_voice or "").lower().strip()
    
    # Explicit Italian voices or codes
    if voice_lower in ("it", "ita", "italian", "if_sara", "giovanni", "sara"):
        return "it"
    if voice_lower.startswith("if_") or voice_lower.startswith("it_"):
        return "it"
        
    # Explicit English voices or codes
    if voice_lower in ("en", "eng", "english", "alba", "af_jessica", "jessica"):
        return "en"
    if voice_lower.startswith("af_") or voice_lower.startswith("am_") or voice_lower.startswith("bf_") or voice_lower.startswith("bm_"):
        return "en"
        
    # Text heuristic: Italian common words
    it_markers = {" il ", " la ", " le ", " un ", " una ", " sono ", " siamo ", " della ", " delle ", " degli ", " per ", " con ", " dei ", " mercato ", " crypto "}
    text_padded = f" {text.lower()} "
    if any(marker in text_padded for marker in it_markers):
        return "it"
        
    # Default to Italian for AIR3
    return "it"

@app.on_event("startup")
def startup_event():
    init_models()

@app.get("/", response_class=HTMLResponse)
@app.head("/")
def home():
    vram = torch.cuda.memory_allocated() / (1024 * 1024) if DEVICE == "cuda" else 0
    return HTMLResponse(content=f"""<!doctype html>
<html lang="it">
<head>
  <meta charset="utf-8">
  <title>AIR3 Neural TTS Server (v2)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b0f19; color: #f1f5f9; margin: 0; padding: 2rem; display: flex; justify-content: center; }}
    .card {{ background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 2rem; max-width: 640px; width: 100%; box-shadow: 0 10px 25px -5px rgba(0,0,0,0.5); }}
    h1 {{ color: #38bdf8; margin-top: 0; font-size: 1.5rem; display: flex; align-items: center; gap: 0.5rem; }}
    .badge {{ background: #059669; color: white; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; text-transform: uppercase; font-weight: bold; }}
    p {{ color: #94a3b8; line-height: 1.5; }}
    .metric {{ display: inline-block; background: #0f172a; padding: 0.5rem 1rem; border-radius: 8px; margin-right: 0.5rem; margin-bottom: 0.5rem; border: 1px solid #1e293b; }}
    .metric strong {{ color: #f8fafc; display: block; font-size: 1.1rem; }}
    .metric span {{ font-size: 0.75rem; color: #64748b; text-transform: uppercase; }}
    textarea {{ width: 100%; box-sizing: border-box; background: #0f172a; border: 1px solid #334155; color: white; border-radius: 8px; padding: 0.75rem; font-family: inherit; margin: 1rem 0; resize: vertical; }}
    select, button {{ background: #0284c7; color: white; border: none; padding: 0.6rem 1.2rem; border-radius: 6px; font-weight: 600; cursor: pointer; transition: background 0.2s; }}
    select {{ background: #0f172a; border: 1px solid #334155; margin-right: 0.5rem; }}
    button:hover {{ background: #0369a1; }}
    audio {{ width: 100%; margin-top: 1rem; border-radius: 8px; }}
    code {{ background: #0f172a; color: #e2e8f0; padding: 0.2rem 0.4rem; border-radius: 4px; font-size: 0.85rem; }}
  </style>
</head>
<body>
  <div class="card">
    <h1>AIR3 Neural TTS Server <span class="badge">Online</span></h1>
    <p>High-speed bilingual neural speech synthesis engine accelerated via hardware on <strong>NVIDIA GeForce RTX 3090</strong>.</p>
    <div>
      <div class="metric"><strong>Pocket-TTS (CUDA)</strong><span>Model</span></div>
      <div class="metric"><strong>{vram:.1f} MB</strong><span>GPU VRAM</span></div>
      <div class="metric"><strong>24,000 Hz</strong><span>PCM16 WAV</span></div>
      <div class="metric"><strong>~200 ms</strong><span>Latency</span></div>
    </div>
    <hr style="border: 0; border-top: 1px solid #334155; margin: 1.5rem 0;">
    <h3 style="margin-top:0">Quick Voice Synthesis Test:</h3>
    <textarea id="text" rows="3">Welcome to AIR3 Live. All broadcast and market intelligence systems are nominal.</textarea>
    <div style="display:flex; align-items:center;">
      <select id="voice">
        <option value="af_jessica">English (Jessica / Alba)</option>
        <option value="if_sara">Italian (Sara / Giovanni)</option>
      </select>
      <button id="btn" onclick="generate()">Synthesize Speech ▶</button>
    </div>
    <audio id="player" controls style="display:none;"></audio>
    <hr style="border: 0; border-top: 1px solid #334155; margin: 1.5rem 0;">
    <p style="font-size:0.8rem; margin:0">OpenAI compatible endpoint: <code>POST /v1/audio/speech</code> | Health: <code>GET /health</code> | Models: <code>GET /v1/models</code></p>
  </div>
  <script>
    async function generate() {{
      const btn = document.getElementById('btn');
      const player = document.getElementById('player');
      btn.disabled = true; btn.textContent = 'Generating speech...';
      try {{
        const text = document.getElementById('text').value;
        const voice = document.getElementById('voice').value;
        const res = await fetch('/v1/audio/speech', {{
          method: 'POST',
          headers: {{ 'Content-Type': 'application/json' }},
          body: JSON.stringify({{ input: text, voice: voice }})
        }});
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        player.src = URL.createObjectURL(blob);
        player.style.display = 'block';
        player.play();
      }} catch (e) {{
        alert('Synthesis error: ' + e.message);
      }} finally {{
        btn.disabled = false; btn.textContent = 'Synthesize Speech ▶';
      }}
    }}
  </script>
</body>
</html>""")

@app.get("/health")
@app.head("/health")
@app.get("/healthz")
@app.head("/healthz")
def health_check():
    vram = torch.cuda.memory_allocated() / (1024 * 1024) if DEVICE == "cuda" else 0
    return {
        "status": "ok",
        "service": "air3-tts-v2",
        "engine": "pocket-tts",
        "device": DEVICE,
        "vram_mb": round(vram, 1),
        "languages": list(models.keys()),
        "sample_rate": 24000
    }

@app.get("/v1/models")
@app.get("/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {"id": "pocket-tts", "object": "model", "owned_by": "air3", "capabilities": ["it", "en"]},
            {"id": "pocket-tts-it", "object": "model", "owned_by": "air3", "language": "it"},
            {"id": "pocket-tts-en", "object": "model", "owned_by": "air3", "language": "en"},
            {"id": "kokoro", "object": "model", "owned_by": "air3", "compatibility": True}
        ]
    }

@app.post("/v1/audio/speech")
@app.post("/audio/speech")
def generate_speech(req: SpeechRequest):
    text = (req.input or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail={"error": "Text input cannot be empty"})
        
    lang = detect_language(text, req.voice or "")
    model = models.get(lang)
    voice_state = voice_states.get(lang)
    
    if not model or voice_state is None:
        raise HTTPException(status_code=500, detail={"error": f"Model for language '{lang}' not ready"})
        
    t0 = time.time()
    try:
        with generation_lock:
            chunks = list(model.generate_audio_stream(voice_state, text))
            
        buf = UnclosableBytesIO()
        stream_audio_chunks(buf, chunks, model.config.mimi.sample_rate)
        wav_bytes = buf.getvalue()
        
        elapsed_ms = int((time.time() - t0) * 1000)
        logger.info(f"Synthesized '{text[:40]}...' ({lang}, {len(wav_bytes)} bytes) in {elapsed_ms}ms")
        
        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "attachment; filename=speech.wav",
                "X-Audio-Sample-Rate": "24000",
                "X-Audio-Channels": "1",
                "X-Elapsed-Ms": str(elapsed_ms),
                "X-Language": lang
            }
        )
    except Exception as e:
        logger.error(f"Synthesis failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail={"error": str(e)})

if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

