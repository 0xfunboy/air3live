# AIR3 Live — Guida Operativa per AI Agent (Autonomous Production Guide)

> **Documento per AI Agent & Sistemi di Automazione**  
> Questa guida contiene tutte le istruzioni tecniche, architetturali e operative necessarie a un AI Agent (Codex, Claude, ElizaOS o agenti autonomi locali) per comprendere, installare, manutenere e pilotare lo studio broadcast **AIR3 Live** in ambiente Linux con accelerazione NVIDIA RTX 3090.

---

## 1. Visione d'Insieme & Obiettivo

**AIR3 Live** è un runtime broadcast 24/7 completamente autonomo progettato per mandare in streaming perenne l'avatar 3D fotorealistico di **AIR3**.
* **Zero intervento umano necessario**: una volta avviato, un watchdog supervisore con backoff esponenziale gestisce riconnessioni, cadute di frame o riavvii del socket RTMP.
* **Pilotabile via API**: agenti esterni (come **ElizaOS** e **AIRdApp**) controllano la presentatrice inviando testo da pronunciare, cambio inquadrature, espressioni emotive e movimenti verso i monitor dello studio via HTTP REST.
* **Nessuna dipendenza da ElizaOS o AIRdApp all'interno del repo**: `air3live` è uno studio broadcast standalone puro in Node.js 24 ESM + WebGL Three.js + Puppeteer Stream + FFmpeg NVENC.

---

## 2. Architettura del Runtime

```
                    ┌────────────────────────────────────────┐
                    │      ElizaOS / AIRdApp / AI Agent      │
                    └───────────────────┬────────────────────┘
                                        │ HTTP REST (Port 5890)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ air3live Runtime (Node.js 24 ESM)                                          │
│                                                                            │
│  ┌──────────────────────┐   WebSocket/IPC   ┌───────────────────────────┐  │
│  │   HTTP & API Gateway │ ◄───────────────► │   Supervisore Watchdog    │  │
│  │  (/api/live/*)       │                   │   (Auto-Recovery 24/7)    │  │
│  └──────────┬───────────┘                   └─────────────┬─────────────┘  │
│             │                                             │                │
│             ▼                                             ▼                │
│  ┌──────────────────────┐                   ┌───────────────────────────┐  │
│  │  Studio 3D Three.js  │                   │  Chromium Headless        │  │
│  │  (Avatar + WebGL)    │                   │  (Capture video NV12)     │  │
│  └──────────┬───────────┘                   └─────────────┬─────────────┘  │
│             │                                             │                │
│             ▼                                             ▼                │
│  ┌──────────────────────┐                   ┌───────────────────────────┐  │
│  │  Rhubarb Lip-Sync    │                   │  FFmpeg Hardware Encoder  │  │
│  │  & Audio Pipeline    │ ────────────────► │  (NVIDIA NVENC h264_nvenc)│  │
│  └──────────────────────┘   PCM Audio Pipe  └─────────────┬─────────────┘  │
└───────────────────────────────────────────────────────────┼────────────────┘
                                                            │ RTMP / RTMPS
                                                            ▼
                                              Restream / Twitch / YouTube
```

### Componenti Principali
1. **Studio 3D WebGL (`studio-broadcast/public/`)**:
   - Modello 3D MetaHuman fotorealistico con blendshape facciali per lip-sync continuo (visemi A-H).
   - Abbigliamento fisso di produzione: Top crop bianco off-shoulder, stivaletti in pelle naturale, taglio ondulato castano caldo.
   - Sguardo attratto verso la telecamera attiva (`air3-attention.mjs`, `look-controller.mjs`).
   - Monitor centrale curvo connesso live alla **AIRdApp Wallboard** (`https://airdapp.airewardrop.xyz/wallboard`).
2. **Gateway & API Server (`studio-broadcast/src/main.mjs`)**:
   - Serve il frontend statico, la console regia (`/control`) e gli endpoint REST protetti da token operatore/producer.
3. **Broadcaster Headless & Encoder (`studio-broadcast/src/broadcast.mjs` & `encoder.mjs`)**:
   - Avvia Chrome headless con GPU hardware rendering, cattura il framebuffer WebGL a 1080p30.
   - Incapsula il video stream in FFmpeg codificando con **`h264_nvenc`** (NVIDIA RTX 3090).
4. **Supervisore 24/7 Watchdog (`studio-broadcast/src/live-process.mjs`)**:
   - Monitora la stabilità del processo FFmpeg e dello stream RTMP.
   - In caso di uscita anomala, tenta il ripristino automatico con backoff (3s, 4.5s, 6.7s... fino a 60s).

---

## 3. Requisiti di Sistema in Produzione (Linux)

* **Macchina**: Ubuntu 24.04/26.04 LTS (x86_64) con NVIDIA GeForce RTX 3090 (24 GB VRAM)
* **Driver NVIDIA**: >= 550 con supporto NVENC (`nvidia-smi` funzionante)
* **Node.js**: >= 24.0.0 (supporto nativo a `process.loadEnvFile`, `parseEnv`, ESM puro)
* **FFmpeg**: Compilato con supporto NVENC (`h264_nvenc`)
* **Librerie di sistema per Chromium Headless**:
  - `libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libdrm2`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libasound2t64` (o `libasound2`), `libpango-1.0-0`

---

## 4. Installazione & Configurazione Passo-Passo

### 4.1. Assicurare Node.js 24 nel PATH
Nel file `~/.bashrc` dell'utente, esportare il percorso di Node 24 prima di qualsiasi blocco interattivo:
```bash
export PATH="$HOME/.local/bin:$HOME/.local/opt/node-v24.18.0-linux-x64/bin:$PATH"
```
Verifica:
```bash
node -v   # Deve riportare v24.x.x
npm -v    # Deve riportare 11.x.x o superiore
```

### 4.2. FFmpeg con Supporto NVENC
Se FFmpeg di sistema non è installato o non ha `h264_nvenc`, installare un build statico con NVENC in `~/.local/bin/ffmpeg`:
```bash
# Verifica supporto NVENC
ffmpeg -encoders 2>/dev/null | grep nvenc
# Deve mostrare: V..... h264_nvenc
```
È possibile specificare il percorso esatto di FFmpeg impostando nel file `.env`:
```ini
AIR3_FFMPEG=/home/funboy/.local/bin/ffmpeg
```

### 4.3. Clonazione o Aggiornamento del Repository
```bash
git clone https://github.com/0xfunboy/air3live.git /home/funboy/air3live
cd /home/funboy/air3live
```

### 4.4. Installazione Dipendenze & Browser Headless
Dalla radice del progetto:
```bash
npm run setup
```
Questo comando esegue automaticamente:
1. `npm ci --prefix studio-broadcast` (installa Three.js, Puppeteer, esbuild, ecc.)
2. `npm run init --prefix studio-broadcast` (genera `.env` con token unici crittografici se non presente)
3. `npm run browser:install --prefix studio-broadcast` (installa la build compatibile di Chrome for Testing in `.cache/browser`)
4. Compila i bundle frontend per lo studio e la regia.

### 4.5. Configurazione delle Chiavi (.env)
Il file `studio-broadcast/.env` contiene le configurazioni operative:
```ini
# Porta del server (default 5890)
PORT=5890
AIR3_PUBLIC_ORIGIN=http://127.0.0.1:5890

# Token di autenticazione per API esterne (ElizaOS / dApp / Operatore)
AIR3_OPERATOR_TOKEN=tuo_token_operatore_segreto_64_hex
AIR3_PRODUCER_TOKEN=tuo_token_producer_segreto_64_hex
AIR3_PLAYER_TOKEN=tuo_token_player_segreto_64_hex

# Destinazioni Streaming (compilare con le chiavi di produzione)
# Per Restream.io:
AIR3_RESTREAM_KEY=live_xxxxxxxxxxxxxx
AIR3_STREAM_URL=rtmp://live.restream.io/live/live_xxxxxxxxxxxxxx

# Per Twitch diretto:
# AIR3_TWITCH_KEY=live_xxxxxxxxxxxxxx
# AIR3_STREAM_URL=rtmp://live.twitch.tv/app/live_xxxxxxxxxxxxxx

# Encoder Video (su RTX 3090 impostare h264_nvenc)
AIR3_ENCODER=h264_nvenc
AIR3_FFMPEG=/home/funboy/.local/bin/ffmpeg

# Wallboard & Dati di Mercato
AIR3_DAPP_BASE_URL=https://airdapp.airewardrop.xyz
```

---

## 5. Modalità di Esecuzione

### 5.1. Avvio Studio + Regia (Control Room Mode)
Per avviare il servizio broadcast con server HTTP, API e console operatore:
```bash
npm run live
# oppure
node scripts/start-live.mjs nvidia
```
URL disponibili:
* **Regia Operatore**: `http://localhost:5890/control` (o via IP server / reverse proxy)
* **Studio 3D**: `http://localhost:5890/studio`
* **Health Check**: `GET http://localhost:5890/healthz`

### 5.2. Avvio Headless Broadcast Diretto (Streaming Daemon)
Per avviare direttamente il flusso video headless verso il server RTMP (senza aprire finestre browser grafiche):
```bash
npm run broadcast
# oppure
node --env-file=studio-broadcast/.env studio-broadcast/src/broadcast.mjs
```

### 5.3. Servizio Systemd per Esecuzione 24/7 Unattended
Per mantenere lo studio permanentemente attivo anche dopo riavvii del server:
Creare `/etc/systemd/system/air3live.service` (o eseguire tramite utente systemd user unit):

```ini
[Unit]
Description=AIR3 Live Autonomous Broadcast Studio
After=network.target

[Service]
Type=simple
User=funboy
WorkingDirectory=/home/funboy/air3live
Environment="PATH=/home/funboy/.local/bin:/home/funboy/.local/opt/node-v24.18.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart=/home/funboy/.local/opt/node-v24.18.0-linux-x64/bin/node scripts/start-live.mjs nvidia
Restart=always
RestartSec=5
KillSignal=SIGINT
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

Abilitazione:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now air3live
sudo systemctl status air3live
```

---

## 6. Pilotaggio da Agenti AI (ElizaOS & REST API Reference)

Tutte le chiamate API devono includere l'header di autenticazione:
`Authorization: Bearer <AIR3_PRODUCER_TOKEN>` oppure `Bearer <AIR3_OPERATOR_TOKEN>`

### 6.1. Far Parlare l'Avatar (Speech & Lip-Sync)
Invia un testo che viene sintetizzato in audio e animato in tempo reale sul modello 3D con sincronizzazione labiale fonetica continua:

```http
POST /api/live/speech
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>

{
  "text": "Benvenuti alla diretta di AIR3! Analizziamo subito l'andamento dei mercati e i dati della AIRdApp.",
  "emotion": "warm_smile",
  "priority": "normal"
}
```

* **Emozioni supportate**:
  - `neutral` (neutra professionale)
  - `warm_smile` (lieve sorriso accogliente — raccomandata per speech standard)
  - `happy` (entusiasta, lieta)
  - `focused` (concentrata, analitica)
  - `mild_surprise` (lieve stupore, breaking news)
  - `thoughtful` (pensierosa, riflessiva)
  - `attentive` (molto attenta)

### 6.2. Cambio Inquadratura Telecamera
```http
POST /api/live/camera
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>

{
  "preset": "half_figure"
}
```
* **Preset camera disponibili**:
  - `wide` (campo largo dello studio ovale con tutti e 3 i monitor)
  - `half_figure` (mezzobusto presentatrice, inquadratura broadcast classica)
  - `close_up` (primo piano viso, ideale per annunci diretti)
  - `monitor_center` (inquadratura focalizzata sul monitor centrale AIRdApp Wallboard)
  - `monitor_left` (inquadratura sul monitor sinistro - Candele e mercati live)
  - `monitor_right` (inquadratura sul monitor destro - Heatmap liquidazioni)

### 6.3. Movimento verso i Monitor (Stage Roaming)
L'avatar cammina realisticamente verso uno dei monitor dello studio, si posiziona e orienta lo sguardo:
```http
POST /api/live/stage
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>

{
  "action": "walk_to_monitor",
  "target": "center"
}
```
Valori possibili per `target`: `"center"`, `"left"`, `"right"`, `"home"` (ritorno alla postazione centrale).

### 6.4. Controllo del Flusso Live (Avvio / Arresto / Watchdog)
* **Stato Live**:
  ```http
  GET /api/live/status
  ```
  Risposta:
  ```json
  {
    "active": true,
    "uptimeSeconds": 14520,
    "autoRecovery": true,
    "encoder": "h264_nvenc",
    "fps": 30,
    "destination": "Restream.io",
    "viewerCount": 142
  }
  ```
* **Forzatura Avvio Stream**:
  ```http
  POST /api/live/stream/start
  ```
* **Arresto Controllato**:
  ```http
  POST /api/live/stream/stop
  ```

---

## 7. Verifica e Test di Integrità

Per verificare che l'installazione sia perfetta e priva di regressioni:

1. **Test Suite Completa (216 Test TAP)**:
   ```bash
   npm test
   ```
   Tutti i 216 test devono passare con 0 errori.

2. **Verifica Render Headless & Rig 3D**:
   ```bash
   npm run smoke
   npm run smoke:avatar
   ```
   Genera render di validazione in `docs/validation/current/` verificando mesh, texture e lip-sync.

3. **Verifica Hardware Encoder NVENC**:
   ```bash
   node studio-broadcast/scripts/check.mjs
   ```
   Conferma che `h264_nvenc` è rilevato e operativo sulla RTX 3090.

---

## 8. Riepilogo Porte e Percorsi Chiave

| Elemento | Valore / Percorso |
| :--- | :--- |
| **Directory Progetto** | `/home/funboy/air3live` |
| **Porta Gateway** | `5890` (HTTP) |
| **URL Console Regia** | `http://localhost:5890/control` |
| **URL Studio WebGL** | `http://localhost:5890/studio` |
| **Health Check** | `http://localhost:5890/healthz` |
| **API ElizaOS / Agent** | `http://localhost:5890/api/live/*` |
| **Dati dApp Wallboard** | `https://airdapp.airewardrop.xyz/wallboard` |
| **Registrazioni Locali** | `/home/funboy/air3live/studio-broadcast/recordings/*.mkv` |
| **Configurazione Segreta** | `/home/funboy/air3live/studio-broadcast/.env` |
