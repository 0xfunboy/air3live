# #AIR3 Live 3.0 — API per regia e agenti

Revisione: 27 ottobre 2026. Implementazione: `studio-broadcast/src/live-service.mjs`, `live-auth.mjs`, `live-settings.mjs`, `live-editorial.mjs` e `gateway.mjs`.

Base locale per i client server-to-server: `http://127.0.0.1:5890`. La regia nel browser usa **`http://localhost:5890/control`**, con callback Twitch `http://localhost:5890/api/live/twitch/callback`, coerente con gli esempi HTTP della [documentazione Twitch](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/). Login, cookie e callback devono usare la stessa origine; il bind e il renderer interno restano su `127.0.0.1`. Nei comandi seguenti i token sono **segnaposto**, da sostituire nel tuo ambiente. Le richieste JSON usano `Content-Type: application/json`. Gli errori sono risposte HTTP con corpo `{"error":"CODICE"}`. I nomi dei campi sono sensibili a maiuscole e minuscole.

## Autenticazione e ruoli

| Ruolo | Credenziale | Operazioni |
| --- | --- | --- |
| Operatore | Sessione della regia oppure `Authorization: Bearer <OPERATOR_TOKEN>` | Impostazioni, avvio/arresto, comandi scena, pubblicazione, registrazioni e OAuth Twitch. |
| Produttore | `Authorization: Bearer <PRODUCER_TOKEN>` | Narrazioni, titoli, wallpanel e ingresso chat esterna. |
| Player | `AIR3_PLAYER_TOKEN`, usato dal player interno | Acquisizione e conferma della coda audio; non è una credenziale di regia. |

I token provengono dalla `.env` del server. Una richiesta server-to-server con bearer non richiede `Origin`. Se un browser invia `Origin`, deve essere esattamente quello della regia anche con un bearer valido. Le mutazioni con cookie richiedono la stessa origine e non accettano una richiesta senza `Origin`. Non passare token come parametri URL.

La UI usa:

- `GET /api/live/session`: restituisce `{"authenticated":true|false}`.
- `POST /api/live/session` con `{"local":true}`: consentito solo sulla loopback, con host/origine locali coerenti e accesso locale abilitato.
- `POST /api/live/session` con `{"token":"<OPERATOR_TOKEN>"}`: login operatore dalla stessa origine.
- `DELETE /api/live/session`: revoca la sessione corrente.

Il cookie dura 12 ore, è HttpOnly e SameSite=Lax; su HTTPS è Secure. Il riavvio del servizio invalida le sessioni in memoria. `AIR3_PUBLIC_ORIGIN` imposta l'origine della regia e del callback Twitch per un'installazione remota.

## Percorsi disponibili

### Letture senza credenziali

| Metodo e percorso | Risposta |
| --- | --- |
| `GET /api/live/program` | `air3.live.program.v1`: revisione, scena, look, titoli e indicatore della sessione. |
| `GET /api/live/market` | Snapshot validato dei monitor e della provenienza/freschezza dei dati. |
| `GET /api/live/session` | Stato dell'autenticazione della richiesta. |

Questi snapshot contengono quanto serve alla scena. Non contengono stream key, chiavi TTS/CoinGlass o token Twitch. I contenuti editoriali pubblicati nei monitor e nei titoli vanno considerati visibili attraverso questi percorsi.

### Regia: operatore

| Metodo e percorso | Corpo / risultato |
| --- | --- |
| `GET /api/live/status` | Stato broadcaster, impostazioni redatte, titoli, chat, mercato e callback OAuth. |
| `GET /api/live/settings` | Impostazioni con indicatori della presenza dei segreti. |
| `PATCH /api/live/settings` | Aggiornamento parziale delle sezioni consentite. |
| `POST /api/live/preflight` | `{"mode":"record"}` / `live` / `twitch-test`; verifica ambiente ed encoder. |
| `POST /api/live/start` | Stessi modi; risposta 202. Senza `mode`, chiede `live`. |
| `POST /api/live/stop` | Arresto della sessione; nessun corpo necessario. |
| `POST /api/live/command` | Movimento verso monitor, rientro o test audio. |
| `GET /api/live/preview.jpg` | Miniatura JPEG; 204 quando non ancora disponibile. Richiede una cattura limitata a una ogni 3 secondi. |
| `POST /api/live/narrations` | Inserisce una narrazione usando la sessione operatore. |
| `GET /api/live/narrations/:id` | Stato della narrazione. |
| `DELETE /api/live/narrations/:id` | Annullamento della narrazione. |
| `GET /api/live/recordings` | Elenco delle registrazioni MKV dell'istanza. |
| `GET /api/live/recordings/:name` | Download del file `studio-….mkv` indicato dall'elenco. |
| `POST /api/live/twitch/authorize` | Restituisce l'URL da aprire nel browser per OAuth. |
| `GET /api/live/twitch/callback` | Callback OAuth con `code` e `state`, legato alla sessione operatore. |
| `POST /api/live/twitch/disconnect` | Rimuove l'autorizzazione Twitch e arresta il collegamento. |

`preflight` usa `record` come modalità predefinita; `start` usa `live`. Per script automatici specifica sempre il modo. Il risultato positivo del preflight verifica l'encoder ma indica `rendererCheck: "performed-on-start"`: il controllo GPU effettivo avviene nel browser avviato. La risposta 202 di `start` non è una conferma di pubblicazione sulla piattaforma.

### Pubblicazione: produttore oppure operatore

| Metodo e percorso | Uso |
| --- | --- |
| `POST/PATCH /api/live/titles` | Titolo, sottotitolo, ticker e scadenza. Alias: `/api/titles`. |
| `DELETE /api/live/titles` | Disattiva e svuota i titoli. Alias: `/api/titles`. |
| `GET /api/live/titles` | Lettura editoriale completa, riservata all'operatore. Il contenuto visibile è anche in `/api/live/program`. |
| `POST /api/live/wallpanel` | Snapshot testuale o AIRTrack del monitor centrale. |
| `POST /api/live/chat/ingest` | Messaggio ricevuto da un bridge Restream/esterno. |

Per mantenere l'integrazione già utilizzata dall'agente, **`POST /api/narrations`**, `GET /api/narrations/:id` e `DELETE /api/narrations/:id` restano disponibili con **token produttore**. Questi percorsi non richiedono dApp o Eliza in esecuzione.

## Impostazioni

`PATCH /api/live/settings` accetta un oggetto con una o più sezioni. I campi sconosciuti o del tipo sbagliato sono rifiutati. Non usare la risposta pubblica come payload integrale di scrittura: include indicatori come `hasKey` che non sono campi di configurazione.

| Sezione | Campi principali |
| --- | --- |
| `stream` | `provider`: `restream`, `twitch`, `custom`; `server`; `key`; `profile`: `720p30`, `1080p30`, `1080p60`; `bitrateKbps`: intero 500–20000; `encoder`: `auto`, `h264_nvenc`, `h264_qsv`, `libx264`; `quality`: `auto`, `high`, `balanced`, `software`; `twitchBandwidthTest`: booleano. |
| `scene` | `camera`: `auto`, `wide`, `presenter`, `screens`; `emotion`: `neutral`, `happy`, `sad`, `surprised`, `warm`, `focused`, `concerned`; `intensity`: 0–1; `eyeContact`, `roaming`: booleani. |
| `tts` | `baseUrl`, `apiKey`, `model`, `voiceIt`, `voiceEn`, `speed`: 0,5–2. |
| `market` | `enabled`; `provider`: `binance`, `coinglass`, `demo`; `symbol`: `BTCUSDT`, `ETHUSDT`, `SOLUSDT`; `range`: `12h`, `24h`, `3d`, `7d`; `wallpanelSource`: `market`, `external`; `coinglassKey`. |
| `twitch` | `enabled`, `clientId`, `clientSecret`, `channel`. Access/refresh token e scope sono gestiti internamente, non accettati da questa API. |
| `look` | Preset completo conforme a `public/look-presets.mjs`. La regia fornisce il formato; non è una patch libera su materiali o percorsi di asset. |

Un campo segreto omesso conserva il valore precedente; un campo segreto impostato esplicitamente a `""` lo cancella. Cambiare provider o server di streaming senza fornire anche `key` cancella la chiave precedente. Cambiare Client ID/Secret Twitch invalida l'autorizzazione precedente e richiede un nuovo OAuth. Non è consentito modificare `stream` mentre un avvio o un broadcaster sono attivi.

Esempio: configurare l'uscita senza avviarla:

```bash
curl -X PATCH http://127.0.0.1:5890/api/live/settings \
  -H 'Authorization: Bearer <OPERATOR_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"stream":{"provider":"restream","server":"rtmps://live.restream.io/live","key":"<STREAM_KEY>","profile":"1080p30","bitrateKbps":4500,"encoder":"auto","quality":"balanced"}}'
```

Sostituisci il server dell'esempio con quello mostrato dal tuo pannello Restream. Il campo `server` ammette RTMP/RTMPS, senza credenziali nell'URL, query o frammenti. `restream` e `twitch` verificano anche il dominio del provider; per un server RTMP tuo usa `custom`. La UI 3.0 usa RTMP/RTMPS; la configurazione CLI storica del broadcaster conserva anche il modo RTSP, che non è un'opzione del pannello LIVE.

## Avvio, stato e arresto

Prova locale senza invio in rete:

```bash
curl -X POST http://127.0.0.1:5890/api/live/start \
  -H 'Authorization: Bearer <OPERATOR_TOKEN>' \
  -H 'Content-Type: application/json' --data '{"mode":"record"}'
```

Dopo avere configurato il canale, una diretta si avvia con lo stesso endpoint e `{"mode":"live"}`. `twitch-test` richiede provider Twitch e aggiunge la modalità di test banda. Tutti gli avvii sono espliciti: il launcher, la lettura degli snapshot e un aggiornamento di impostazioni non avviano la trasmissione.

```bash
curl http://127.0.0.1:5890/api/live/status \
  -H 'Authorization: Bearer <OPERATOR_TOKEN>'

curl -X POST http://127.0.0.1:5890/api/live/stop \
  -H 'Authorization: Bearer <OPERATOR_TOKEN>'
```

`broadcast.phase` distingue `stopped`, `preflight`, `starting`, `running`, `stalled`, `reconnecting`, `stopping` e `failed`. `running` richiede frame o tempo dell'encoder in avanzamento. `fps` riguarda l'uscita codificata; `renderFps` è misurato nel renderer. Uno stop durante il preflight annulla l'avvio e impedisce un processo tardivo. Se l'uscita del processo non viene confermata entro i timeout, l'API restituisce `BROADCAST_STOP_TIMEOUT` e mantiene la proprietà del processo, impedendo un secondo avvio concorrente.

## Narrazioni: bridge dell'agente

Il produttore può inviare il testo appena lo genera. Questo esempio indica il monitor centrale durante l'intervento e applica l'espressione felice:

```bash
curl -X POST http://127.0.0.1:5890/api/narrations \
  -H 'Authorization: Bearer <PRODUCER_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"id":"editorial-001","text":"Benvenuti. Sul monitor centrale trovate il riepilogo della sessione.","language":"it","emotion":{"name":"happy","intensity":1},"presentation":{"action":"monitor","monitor":"center"}}'
```

| Campo | Regola |
| --- | --- |
| `id` | Facoltativo; 1–128 caratteri alfanumerici, `_`, `.`, `-`, con primo carattere alfanumerico. Se manca viene generato. |
| `text` | Obbligatorio, non vuoto; massimo predefinito 8000 caratteri, configurabile sul servizio. |
| `language` | `it` o `en`; predefinita `en`. |
| `emotion` | Nome di emozione oppure `{ "name": "happy", "intensity": 1 }`. Le intensità sono 0–1. |
| `presentation` | `{ "action": "monitor", "monitor": "left|center|right" }` oppure `{ "action": "home" }`. |
| `priority` | Intero da -100 a 100; predefinito 0. |
| `expiresAt` | Facoltativo: timestamp Unix in **millisecondi**. La coda applica anche il proprio limite di età, predefinito cinque minuti. |

Per i retry usa lo stesso `id` e lo stesso contenuto. Riutilizzare un ID con testo o metadati diversi produce `IDEMPOTENCY_CONFLICT`. Una risposta 202 conferma l'inserimento, non la sintesi né l'avvenuta lettura. Segui lo stato con `GET /api/narrations/editorial-001`; puoi annullare con `DELETE` sullo stesso percorso e lo stesso bearer produttore.

Il contratto audio è quello del server configurato in `tts`: endpoint compatibile `/v1/audio/speech`, richiesta con `model`, `voice`, `input`, `response_format: "wav"` e `speed`. Il gateway conserva coda e file audio, mentre il player segue il clock di riproduzione per il lipsync. Per un nuovo TTS non basta il nome commerciale del modello: l'endpoint deve rispettare questa interfaccia oppure essere adattato dietro di essa.

## Titoli e ticker con scadenza

```bash
curl -X POST http://127.0.0.1:5890/api/live/titles \
  -H 'Authorization: Bearer <PRODUCER_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"enabled":true,"label":"MERCATI","title":"Il punto della sessione","subtitle":"Aggiornamenti a cura di AIR3","ticker":["Riepilogo dei mercati in corso","Fonti e freschezza sono indicate sui monitor"],"speed":65,"ttlSeconds":300}'
```

Limiti: etichetta 32 caratteri, titolo 120, sottotitolo 220; ticker massimo 12 righe da 240 caratteri. `ticker` può essere un array oppure una stringa con righe separate da newline. `speed` è in pixel/secondo, tra 20 e 160. `ttlSeconds` è un intero fra 0 e 86400: zero mantiene il titolo, un valore positivo stabilisce una scadenza a partire dall'aggiornamento server.

La risposta include `expiresAt` e `updatedAt`. La scadenza sopravvive al riavvio: riaprire il servizio non rinnova un titolo vecchio. `DELETE /api/live/titles` lo disattiva e svuota titolo, sottotitolo e ticker. I contenuti sono trattati come testo, senza HTML o script. Questi titoli sono nel video; l'API non cambia il titolo pubblico della trasmissione Twitch/Restream.

## Wallpanel centrale

L'operatore attiva il wallpanel esterno una volta:

```bash
curl -X PATCH http://127.0.0.1:5890/api/live/settings \
  -H 'Authorization: Bearer <OPERATOR_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"market":{"wallpanelSource":"external"}}'
```

Poi l'agente invia uno snapshot:

```bash
curl -X POST http://127.0.0.1:5890/api/live/wallpanel \
  -H 'Authorization: Bearer <PRODUCER_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"title":"MARKET WALLPANEL","subtitle":"Riepilogo della sessione","source":"Agente AIR3","ttlSeconds":300,"cards":[{"label":"Mercato","value":"BTC / USDT","tone":"neutral"}],"rows":[{"label":"Aggiornamento","value":"In attesa dei dati","detail":"Sostituire con informazioni verificate."}]}'
```

Sono ammessi al massimo sei card e otto righe; TTL tra 15 e 86400 secondi. La scadenza segnala un pannello non aggiornato. L'esempio descrive uno stato di attesa e non presenta cifre di mercato inventate.

Per il wallpanel AIRTrack invia i DTO esistenti:

```json
{
  "title": "AIRTRACK WALLPANEL",
  "source": "AIRTrack",
  "ttlSeconds": 60,
  "trades": [],
  "selectedId": null,
  "candles": [],
  "report": {
    "totals": { "open": 0, "pending": 0, "closed": 0 },
    "pnl_realized_pct_sum": null
  }
}
```

`trades` accetta l'array o `{ "items": [...] }`; `candles` l'array o `{ "data": [...] }`. Dettagli su stati, prezzi, selezione e freschezza sono in [MONITOR_LIVE.md](MONITOR_LIVE.md). I dati di trading inviati vanno mantenuti distinti dalle posizioni effettive del vault; il modulo non esegue ordini e non riclassifica un segnale come investimento reale.

## Comandi di scena

```bash
curl -X POST http://127.0.0.1:5890/api/live/command \
  -H 'Authorization: Bearer <OPERATOR_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"type":"monitor","monitor":"right"}'
```

Gli altri corpi sono `{"type":"home"}`, `{"type":"test-voice"}` e `{"type":"stop-test-voice"}`. Questi comandi agiscono sul renderer posseduto dal broadcaster attivo. Quando è fermo restituiscono `BROADCAST_NOT_ACTIVE`. Per associare un gesto al testo generato dall'agente usa invece `presentation` nella narrazione: il produttore non necessita del token operatore.

## Chat esterna e OAuth

Un bridge che già riceve messaggi Restream può alimentarli nella regia:

```bash
curl -X POST http://127.0.0.1:5890/api/live/chat/ingest \
  -H 'Authorization: Bearer <PRODUCER_TOKEN>' \
  -H 'Content-Type: application/json' \
  --data '{"provider":"restream","author":"spettatore","text":"Buongiorno alla redazione"}'
```

`provider` è `restream` o `external`; massimo 80 caratteri per autore e 1000 per testo. La risposta 202 contiene l'ID del messaggio; lo stato della regia mostra gli ultimi messaggi. Il servizio non ricava automaticamente le credenziali del bridge e non inoltra quei messaggi al TTS o ai comandi dell'avatar.

Per la chat Twitch integrata, la UI configura Client ID/Secret, canale ed `enabled`, poi apre l'URL ottenuto da `/api/live/twitch/authorize`. Il callback è legato a `state` e alla sessione operatore. Il token autorizza la lettura `user:read:chat`; viene salvato e rinnovato lato server. Vedi [TWITCH_CHAT_3.0.md](TWITCH_CHAT_3.0.md) per la configurazione registrata e le prove effettuate. Non sono esposti endpoint per inviare messaggi al canale.

## Compatibilità e limiti di verifica

La separazione è additiva: un agente esistente può mantenere `/api/narrations` e aggiungere titoli/wallpanel senza importare la dApp nel processo di streaming. Le API di regia e di pubblicazione usano credenziali diverse. `/api/live/program` e `/api/live/market` alimentano canvas e controlli della scena attraverso la stessa origine; non sono un WebSocket bidirezionale del backend pubblico della dApp.

Il log `docs/validation/current/live-boundary-tests.txt` contiene 34 test passati su questi confini e sul launcher. `docs/validation/current/live-launcher/report.json` aggiunge sette controlli di avvio/arresto, sessione e coerenza dell'origine del callback contro un gateway locale reale, senza broadcaster né feed esterni. I test con processi, socket e OAuth controllati non sostituiscono l'autorizzazione Twitch reale, la verifica del TTS dell'utente, il collegamento del server ai feed di mercato o la prova live con la chiave del canale. La qualità e il frame rate devono essere valutati sul renderer e sulla registrazione effettivi, non dedotti dal solo profilo selezionato.
