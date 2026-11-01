# AIR3 Live Twitch e integrazione Three.js

Knowledge tecnico e operativo aggiornato al **1 novembre 2026**, per preparare il passaggio dallo studio Unreal al nuovo studio Three.js senza modificare ora Eliza, il trading o la trasmissione. La soluzione consigliata è conservare l'intelligenza editoriale e la chat in Eliza e delegare al gateway `air3live` coda audio, sintesi, lip sync, movimenti associati alla frase e trasmissione.

Il nuovo studio è già operativo. Non serve riscriverne la coda o installare un secondo sistema di rendering. Serve invece un adapter producer in Eliza, con consegna persistente, identità stabili dei messaggi e gestione esplicita dell'esito della riproduzione. **Questo adapter non è stato implementato né attivato durante l'indagine.**

## Ambito e stato delle verifiche

- Eliza locale: `/home/cooper/AIR3/eliza-air3`, commit `98dcf74b2ed4b08be90a8b19fbd4e7bd27df5451`, worktree pulito.
- dApp locale: `/home/cooper/AIR3/dapp-air3`, commit `c2fa07d420e7c95b198f964a91da51e26213061c`, worktree pulito.
- Studio remoto: `funboy@93.56.125.228`, porta SSH `6666`, directory `/home/funboy/air3live`; riferimento LAN comunicato dall'operatore: `192.168.178.47`, host Prod-3090.
- Studio remoto: commit `eaf1a89b26a4c10612820728d903eea94839e877`. Il worktree contiene una modifica preesistente a `adapters/dapp-wallpanel.mjs`: due stringhe del pannello sono state tradotte in inglese. Non è una modifica funzionale e non è stata toccata.
- Accesso SSH verificato con la chiave dedicata `/home/cooper/.ssh/id_ed25519_air3live`, creata e autorizzata dall'operatore. Nessuna chiave privata viene riportata qui.
- Ispezione di sorgenti, documentazione, asset pubblici, configurazioni selezionate e stato operativo con sole letture. Nessun invio di narrazioni, chat, titoli, movimenti, claim audio o comandi di streaming; nessun riavvio, build, installazione, commit o push.
- Le suite di test sono state esaminate come sorgente, **non eseguite**. Non attribuire a questa indagine il superamento dei test dichiarato nelle guide remote.
- Unico artefatto creato dall'assistente: questo file, esterno ai due repository locali di produzione.

## Come funziona oggi Eliza

### Generazione e chat

Il character `characters/AIR3.character.json` abilita `twitter`, `discord`, `telegram` e `twitch`, con i plugin `air-market`, `air-trade-generator` e `air-web-search`. Il client Twitch viene avviato in un `try/catch` separato: un errore iniziale di Twitch non deve terminare gli altri client.

Il client `packages/client-twitch` gestisce due flussi:

1. Narration autonoma durante l'inattività della chat.
2. Risposte alle menzioni del bot `air3agent` o del canale `airewardrop`, tramite action dei plugin oppure fallback LLM.

L'ingresso chat usa EventSub WebSocket; l'uscita usa Helix Send Chat Message. OAuth, riconnessioni e circuito di invio chat sono separati dalla voce: un problema di autenticazione o una quota Twitch non devono spegnere la narrazione autonoma.

La rotazione idle contiene sette rubriche:

| Ordine | Rubrica | Fonte principale nel codice |
|---|---|---|
| 0 | News | RSS configurabile, default Cointelegraph |
| 1 | Sentiment | Fear and Greed CoinMarketCap |
| 2 | Volumi | CryptoCompare |
| 3 | Trending | CoinGecko |
| 4 | Nuovi listing | CoinMarketCap |
| 5 | Token boosted | Dexscreener |
| 6 | Most mentioned | Scraping della pagina configurata, con Puppeteer |

L'intervallo è **60 secondi di inattività**. Il timer viene sospeso durante la lavorazione e riparte al termine: non significa una nuova frase ogni 60 secondi di orologio indipendentemente dalla durata di LLM e TTS.

Configurazione locale rilevata: `TWITCH_MODEL_PROVIDER=gemrouter`, `TWITCH_MODEL=gemma-4-31b-it`. Il percorso effettivo usa `twitchGenerateText` e gli override scoped; il vecchio helper `config/model.ts`, che contiene un nome DeepSeek di fallback, non è prova che la voce attuale usi DeepSeek.

### Voce e collegamento con lo studio precedente

Il punto comune delle rubriche e delle risposte è:

`packages/client-twitch/src/utils/textToSpeech.ts` → `generateAndSaveTTS(text)`.

Il percorso rilevato è:

```text
Fonti e plugin → LLM Eliza → testo ripulito e suddiviso per Twitch
                              ├→ Kokoro Gradio /generate_full
                              └→ coda best effort → chat Twitch
```

Configurazione attuale:

- TTS abilitato con `TWITCH_TTS_ENABLE=true`.
- Endpoint `https://tts-api.airewardrop.xyz/`.
- Voce `af_jessica`, velocità `1.0`, GPU richiesta nel payload Gradio.
- Autenticazione Basic e `X-API-Key` configurate; valori esclusi dal knowledge.
- Timeout di default: connessione TTS 15 s, generazione 120 s, chiamata LLM 120 s, task di narrazione complessivo 180 s.
- Limite chat comune: fino a sei chunk da 500 caratteri. In generale il TTS riceve il loro testo concatenato; la rubrica boosted applica anche una pulizia specifica dei token al testo parlato.

Il helper aspetta l'esito della generazione Gradio, ma restituisce `Promise<void>` e gestisce molti errori internamente senza propagarli. **Il completamento del helper non dimostra che il pubblico abbia ascoltato l'audio.** Nel client non c'è una conferma della riproduzione effettuata dallo studio Unreal, né un protocollo diretto per muoverne l'avatar. La successiva acquisizione dell'audio e la trasmissione del vecchio studio sono esterne a questo percorso Eliza.

La serializzazione attuale protegge i task LLM/TTS attraverso lease locali, abort signal e generazioni del client. Non va confusa con il lease distribuito di playback del nuovo studio.

Nel campione delle ultime 2.600 righe del log `log/air3-2026-11-01-06-25-03.log` sono state contate 44 occorrenze di idle tick e 44 connessioni TTS riuscite, senza occorrenze dei marker di errore connessione, timeout TTS o timeout task. Sono indicatori di generazione e connessione, non attestazioni di ascolto o di corretto lip sync. Il servizio `eliza-air3.service` risultava attivo.

### Grafici e dApp

Le action `cryptoChartAction.ts` e `tokenChartAction.ts` richiamano `uploadChartToMonitor` in `packages/plugin-air-market/src/utils/chartMonitorUpload.ts`. Il vecchio trasporto aggiorna un file `latest.jpg` tramite **HTTPS PUT con Basic Auth**: i nomi `TWITCH_FTP_*` sono rimasti storici, non descrivono più un upload FTP. La funzione è condivisa fra client, non esclusiva di Twitch.

Questo canale immagini non è automaticamente compatibile con il wallpanel strutturato del nuovo studio. Non bisogna cambiare le sue variabili globali alla cieca, perché si altererebbe anche il comportamento delle altre piattaforme.

La dApp incorpora Twitch nella pagina Sponsor e pubblica link Twitch/X Live nella Home. Se cambia soltanto la sorgente che trasmette sullo stesso canale Twitch, non serve cambiare l'embed. Incorporare invece direttamente il canvas Three.js richiederebbe valutare prestazioni, audio, modalità observer e CSP: il backend dApp consente attualmente come frame origin Twitch e Solflare, non il dominio del nuovo studio.

## Stato verificato del nuovo studio

### Componenti già presenti

```text
Eliza producer → gateway HTTP → SQLite narrations
                                  ↓
                     TTS OpenAI compatible → WAV → Rhubarb
                                  ↓
                    player con lease → Web Audio e Three.js
                                  ↓
                    Chromium headless → FFmpeg → RTMP o RTMPS

dApp pubblica → bridge wallpanel e feed di mercato → monitor nello studio
```

Il gateway è separato dal backend che opera i fondi. La porta locale configurata è `5890`. Il dominio pubblico è `https://live.airewardrop.xyz`; la Control Room è indicata dal progetto come `https://livedash.airewardrop.xyz` e usa i propri permessi operator.

Servizi utente rilevati attivi sul server: `air3-live.service`, `air3-tts.service`, `air3-dapp-bridge.service`, `air3-cloudflared.service`.

Snapshot operativo del **1 novembre 2026, 09:46:34 Europe/Rome**:

- Broadcast `running`, modalità `live`, encoder `h264_nvenc`, profilo `1080p30`.
- Renderer: `ANGLE (NVIDIA Corporation, NVIDIA GeForce RTX 3090/PCIe/SSE2, OpenGL ES 3.2)`.
- FPS dichiarati dall'encoder: 30; misura `renderFps` nel singolo campione: 22,4. Non è una misura continuativa né prova di 30 frame nuovi renderizzati ogni secondo.
- Il preset persistito di qualità è `software`, ma **il renderer osservato usa NVIDIA**. Il nome del preset non prova l'uso di un renderer software.
- `AIR3_REQUIRE_HARDWARE_RENDERING=false` nell'env: esiste quindi un punto da qualificare prima di pretendere un comportamento fail-closed in caso di perdita della GPU, senza modificarlo ora.
- Chat interna allo studio `disabled`, non autorizzata e configurata read-only. Non sostituisce oggi il client conversazionale Twitch di Eliza.

### TTS effettivo e impostazioni persistite

Lo studio parla a un endpoint OpenAI compatible locale, origine `http://127.0.0.1:8880`. Il servizio attivo è quello Pocket-TTS CUDA, **non** `adapters/tts-gradio-adapter.mjs`. Il nome `model=kokoro` conservato nelle impostazioni è un dato del contratto compatibile, non basta a identificare il processo di sintesi effettivo.

Le impostazioni lette dalla Control Room indicavano voce inglese `af_jessica`, voce italiana `if_sara`, velocità `1`. Queste impostazioni possono prevalere sull'env: per esempio l'env riportava `AIR3_TTS_VOICE_IT=af_jessica`, mentre lo store attivo restituiva `if_sara`. Anche `quality=software` persistito differiva da `AIR3_RENDER_QUALITY=high` nell'env. Per la futura integrazione va letta la configurazione attiva, non dedotta dal solo `.env`.

La sintesi deve essere richiesta **una sola volta**, dal nuovo gateway. Inviare la stessa frase prima al vecchio Gradio da Eliza e poi a `/api/narrations` produrrebbe due percorsi audio indipendenti.

## Credenziali e autorizzazioni reali

Il file remoto `studio-broadcast/.env`, nella directory del progetto, ha permessi `0600`. Contiene `AIR3_PRODUCER_TOKEN`, `AIR3_PLAYER_TOKEN` e `AIR3_OPERATOR_TOKEN`, tutti presenti, lunghi almeno 32 caratteri e distinti. Il bearer producer è stato individuato in questa sorgente privata: **non è copiato nel knowledge, nel repository Eliza, in URL o in log**. Non è stato effettuato un POST per provarlo.

Il gate pubblico è stato verificato senza creare job: un `GET /api/narrations` sulla collection senza ID restituisce `401 UNAUTHORIZED` senza credenziale e `404 NOT_FOUND` con il bearer producer. Il secondo esito è atteso: il codice accetta l'autenticazione, ma non implementa una lista GET su quella collection. Questa prova non invoca `queue.get` e non certifica sintesi o playback; per creare un job resta necessario il POST autorizzato in una futura fase operativa.

| Funzione | Endpoint | Autorità verificata nel codice |
|---|---|---|
| Creare una narrazione | `POST /api/narrations` | Producer |
| Leggere o cancellare un job per ID | `GET` / `DELETE /api/narrations/:id` | Producer condiviso del servizio; non c'è isolamento per un diverso producer utente |
| Titoli e ticker | `POST` / `PATCH /api/live/titles` | Producer oppure operator |
| Snapshot wallpanel | `POST /api/live/wallpanel` | Producer oppure operator |
| Chat esterna da mostrare in regia | `POST /api/live/chat/ingest` | Producer oppure operator; non genera automaticamente voce o comandi |
| Claim audio, heartbeat e conferme playback | `/api/player/*`, `/api/audio/*` | Player, non producer e non operator |
| Camera, scena, start/stop trasmissione e impostazioni | `/api/live/settings`, `/api/live/command`, `/api/live/start`, `/api/live/stop` | Operator |
| Alias narrazione della Control Room | `/api/live/narrations` e relativo job | Operator nel codice corrente |

**Discrepanza da non portare nell'integrazione:** `AI_AGENT_GUIDE.md`, `LIVE_API_3.0.md` e `PRESENTATION_API.md` presentano alcuni endpoint `/api/live/*` come utilizzabili dal producer. In `live-service.mjs`, però, il gate `auth.requireOperator(...)` precede gli handler `/api/live/command` e `/api/live/narrations`. Il producer Eliza deve usare l'endpoint comunicato dall'operatore, **`https://live.airewardrop.xyz/api/narrations`**, non sostituirlo con l'alias della guida.

La regia associata alla singola frase può usare `presentation` nella richiesta producer. La regia globale non deve essere ottenuta distribuendo a Eliza il token operator: per un'eventuale automazione della camera andrebbe definita un'autorità più limitata oppure mantenuta nella Control Room.

Nota sulle letture: `GET /api/narrations/:id` invoca `queue.get`, che esegue anche lo sweep delle scadenze. Non è stato chiamato durante questa indagine per evitare transizioni di job. Nella futura integrazione quel comportamento è parte del normale protocollo operativo.

## Contratto producer verificato

Headers:

```http
Content-Type: application/json
Authorization: Bearer <AIR3_PRODUCER_TOKEN>
```

Il body supporta:

| Campo | Regola verificata |
|---|---|
| `id` | Opzionale sul server, ma da rendere obbligatorio nel producer. Primo carattere alfanumerico; poi lettere, numeri, `_`, `-`, `.`; massimo 128 caratteri. |
| `text` | Stringa non vuota, senza NUL; massimo configurato 8.000 caratteri. |
| `language` | `en` oppure `it`, default `en`. |
| `emotion` | Nome oppure oggetto `{name,intensity}`; intensità fra 0 e 1. |
| `priority` | Intero da -100 a 100, default 0. Non interrompe automaticamente l'audio già in corso. |
| `expiresAt` | Intero Unix epoch in millisecondi, futuro e non oltre il TTL massimo del servizio rispetto all'accettazione. |
| `presentation` | Assente, `{action:"home"}`, oppure `{action:"monitor",monitor:...}` con monitor `left`, `center` o `right`. Altri campi o monitor sono rifiutati. |

Emozioni canoniche: `neutral`, `happy`, `sad`, `surprised`, `warm`, `focused`, `concerned`. Il server accetta anche alcuni alias italiani, ma l'adapter dovrebbe usare i nomi canonici.

Esempio di costruzione del payload, **non inviato**, da eseguire una sola volta quando si registra l'intento nell'outbox:

```js
const createdAt = Date.now();
const payload = {
  id: persistedNarrationId,
  text: validatedSpokenText,
  language: "en",
  emotion: { name: "focused", intensity: 0.4 },
  presentation: { action: "monitor", monitor: "center" },
  priority: 0,
  expiresAt: createdAt + 180_000,
};
// Persistire ID e payload insieme. Nei retry riusare gli stessi valori.
```

`180_000` è una proposta iniziale per il producer, non un cambio alla configurazione esistente. Il TTL va dimensionato sulla durata reale della frase e della sintesi.

Risposta dell'endpoint effettivo: HTTP `202` con `id`, `status`, `duplicate`. Lo stato iniziale è `queued`, **non** `pending` come mostrato in un esempio della guida. L'ACK HTTP non significa che la frase sia già stata pronunciata.

### Idempotenza e limiti

- ID uguale e contenuto uguale: ritorna il job esistente con `duplicate=true`.
- ID uguale ma testo, lingua, priorità, scadenza, emozione o movimento diversi: `409 IDEMPOTENCY_CONFLICT`.
- Il producer deve congelare anche `expiresAt`: ricalcolarlo al retry cambia l'hash e causa conflitto.
- Non convertire un timeout in un nuovo ID. Prima cercare il job con lo stesso ID; un eventuale reinvio deve avere lo stesso payload e rimanere entro la scadenza.
- Queue limit attuale: 20 job attivi, complessivamente fra `queued`, `generating`, `ready`, `leased`, `playing`; oltre il limite `429 QUEUE_FULL`.
- TTL massimo attuale: 300.000 ms; lease player: 15.000 ms; retention dei job terminali: 3.600.000 ms.
- La retention limita anche la memoria di idempotenza. Dopo la rimozione di un job, un ID riutilizzato non è una garanzia di deduplica perpetua. L'outbox Eliza deve fermare definitivamente gli intenti terminali e non ripubblicare contenuti scaduti.

## Playback e movimenti

Stati normali della coda:

```text
queued → generating → ready → leased → playing → finished
                  ↘ failed / cancelled / expired
```

Le decisioni di claim sono atomiche su SQLite e ammettono un solo job `leased` o `playing` per volta. Il player invia `started`, `heartbeat`, `finished` o `failed` con `playerId` e `leaseToken`; una tab pubblica in modalità observer non deve prendere il controllo della voce.

Il gateway non avvia una frase se la sua durata più un margine di 2 s non rientra nella scadenza residua. Un lease perso o una ripartenza durante un audio potenzialmente già pronunciato porta alla scadenza del job, non alla sua riproduzione automatica da capo.

Rhubarb è configurato in modalità `auto`; il player supporta i mouth cue e il fallback su ampiezza audio. **La presenza della modalità auto non attesta che ogni job abbia lip sync fonetico**: va verificato sul singolo esito. Il clock corretto per la bocca è Web Audio, non il numero di frame o l'istante del POST.

Il movimento `presentation` è conservato con il job e viene applicato dal player insieme alla riproduzione. È preferibile a un comando globale inviato molto prima: mantiene frase e gesto collegati e rientra nell'idempotenza della narrazione.

Il percorso di trasmissione attuale è headless, senza necessità architetturale di OBS. Per qualsiasi player browser va comunque verificato che `AudioContext` sia `running`: una pagina WebGL visibile non dimostra che l'audio sia autorizzato o catturato nell'uscita broadcast.

## Integrazione consigliata per Eliza

### Separare contenuto e destinazione della voce

Mantenere rubriche, fonti, risposte alle menzioni, memorie e prompt nel client esistente. Introdurre un adapter esplicito per la narrazione, per esempio `publishNarration(intent)`, con backend selezionabile `legacy` oppure `air3live`. Evitare di trasformare silenziosamente `generateAndSaveTTS` in un POST che continua a restituire `void` senza un esito osservabile.

L'intento dovrebbe contenere almeno ID stabile, tipo di contenuto, testo parlato, lingua, scadenza assoluta, provenienza e riferimenti ai dati usati. L'adapter traduce soltanto i campi ammessi dal contratto HTTP. Il testo chat resta una destinazione separata: non va usato come segnale che la voce sia andata in onda.

La migrazione meno invasiva è in due fasi:

1. **Prima compatibilità:** conservare la selezione editoriale attuale e la coda di task Eliza, sostituendo soltanto il sink vocale nel punto comune e aggiungendo l'outbox. Non modificare azioni di trading, parser o pubblicazioni coordinate.
2. **Poi regia editoriale:** usare stato terminale dei job per governare la prossima rubrica, introdurre priorità per le domande e una mappatura deterministica fra argomento e gesto. Non avviare una seconda rotazione idle nel nuovo studio.

### Outbox e gestione degli errori

L'outbox deve persistere ID e payload prima dell'invio e riconciliare lo stato dopo una ripartenza. Distinguere consegna HTTP, audio pronto e riproduzione terminata. Dopo un timeout di POST lo stato è incerto finché non viene riconciliato: non trattarlo né come successo definitivo né come mancata consegna certa.

Gestione prevista:

- `400`: contenuto o schema non valido, niente loop di retry.
- `401`/`403`: credenziale o ruolo errato; sospendere il sink e avvisare senza stampare token. Controllare subito l'errore di endpoint `/api/live/narrations` contro `/api/narrations`.
- `409 IDEMPOTENCY_CONFLICT`: errore di consistenza del producer, non risolvibile creando un altro ID.
- `429`: rispettare eventuale `Retry-After`, altrimenti backoff limitato e scadenza originaria; non accumulare molte rubriche vecchie.
- Timeout o errore transitorio: riconciliare per ID, poi eventuale retry limitato con payload identico. Nessun replay oltre TTL.
- `expired`, `failed`, `cancelled`: stato terminale; nessun reinvio automatico della stessa notizia con un nuovo ID.

Il cambio `legacy`/`air3live` deve essere controllato e avere un solo proprietario della voce. Dopo un invio incerto non attivare automaticamente anche il TTS legacy: si rischia di mandare la stessa frase su due studi. Il rollback deve prima riconciliare o far scadere gli intenti del nuovo sink.

### Fonti visive e regia

Esiste già `air3-dapp-bridge.service`, basato su `adapters/dapp-wallpanel.mjs`: legge endpoint pubblici della dApp e pubblica snapshot strutturati al wallpanel. Non contiene un generatore di narrazioni. Il codice ha polling non sovrapposto, rifiuto dei redirect e delle risposte eccessive, backoff e controllo di generazione. I default sono polling trade 4 s, candele 15 s, report 60 s, TTL pannello 30 s; gli override del servizio vanno verificati prima di assumerli come valori effettivi.

Riutilizzare quel bridge e i feed del nuovo studio, invece di aggiungere letture RPC, un altro scraper del wallboard o un secondo writer per gli stessi monitor. Se in futuro Eliza deve mostrare un grafico generato dalle action, definire un contratto specifico: l'attuale `PUT latest.jpg` non deve diventare implicitamente un `POST /api/live/wallpanel` con un payload incompatibile.

Mappatura editoriale iniziale proposta:

- Analisi dApp o trade: `presentation.monitor=center`, emozione `focused`.
- Contesto mercato o order book: `left` quando il contenuto effettivamente mostrato coincide con la frase.
- Liquidazioni/heatmap: `right`, distinguendo liquidazioni eseguite da stime o feed sintetici.
- Introduzione o risposta breve: nessun movimento, oppure `home` come intento esplicito.

La camera globale resta alla Control Room. Il producer non deve modificare look, trasmissione o impostazioni del renderer per accompagnare una semplice frase.

### Fedeltà dei dati finanziari

Non confondere AIRTrack, proposte AIRTrading e trade realmente eseguiti. Un `PENDING` non va presentato come posizione aperta; un profitto non realizzato non va annunciato come incassato. Usare fonte, timestamp, identificativo del trade e stato verificato; per i riepiloghi distinguere PnL lordo/netto, fees e funding quando disponibili.

Nessun comando chat o output LLM deve diventare una chiamata di trading attraverso il sistema di regia. Il token producer dello studio non deve dare accesso a chiavi wallet, broker o funzioni di prelievo. La disponibilità del broadcast non deve essere un requisito per aprire, proteggere o chiudere posizioni nella vault.

## Sicurezza e punti da qualificare

1. **Credenziali TTS nel codice remoto.** `adapters/tts-gradio-adapter.mjs`, tracciato da Git, contiene fallback hardcoded per password Basic e API key. Non sono riportati qui. Il servizio TTS attivo non usa oggi questo adapter, ma prima di riutilizzarlo vanno eliminati i fallback e ruotate le credenziali coinvolte, considerando anche la storia Git. Nessuna rotazione è stata effettuata nell'indagine.
2. **Download audio dell'adapter legacy.** Il codice scarica l'URL restituito da Gradio allegando nuovamente le credenziali. Prima di un suo eventuale riuso occorrono vincoli su origine, redirect e dimensione dei dati per evitare inoltro di credenziali o richieste a destinazioni arbitrarie. La relativa coda in memoria non ha un limite esplicito di lunghezza; due richieste concorrenti non equivalgono a un backlog limitato.
3. **Guide non allineate al backend.** Ruoli, alias di narrazione, nomi delle variabili encoder/stream e stato iniziale del job differiscono in alcuni documenti. Per l'implementazione seguire `config.mjs`, `gateway.mjs`, `live-service.mjs` e `queue.mjs`, non copiare meccanicamente gli esempi delle guide.
4. **Segreti distinti e privilegi minimi.** Conservare il producer in un file privato del solo worker, mai in knowledge caricabile dal modello, prompt, frontend `VITE_*`, URL o log. Il producer condiviso può anche pubblicare titoli e wallpanel e cancellare job: non è una credenziale limitata alla sola voce. Non consegnare al componente editoriale anche operator e player.
5. **Chat non attendibile.** Messaggi e feed possono contenere istruzioni ostili: trattarli come dati. Regia tramite enum e policy deterministica; niente JavaScript, shell, URL o coordinate arbitrarie generati dal modello. Il testo mostrato deve rimanere testo, non HTML eseguibile.
6. **Impostazioni e GPU.** Qualificare la differenza fra env e store persistito, perdita del contesto WebGL, audio sospeso, restart del browser e perdita del lease. NVENC attivo non certifica da solo il numero di frame renderizzati o la presenza dell'audio all'uscita.

## Piano futuro di verifica e attivazione

Nessuno di questi passaggi è stato eseguito in questa sessione.

1. Allineare il contratto implementativo: endpoint producer corretto, schema, codici di errore, retention e ruoli. Separare la bonifica dell'adapter legacy dalla migrazione del sink Eliza.
2. Implementare adapter e outbox con flag inizialmente disabilitato, testando soltanto contro HTTP e playback finti. Conservare il fallback legacy come opzione esplicita, non come invio parallelo.
3. Provare i casi di ID duplicato/conflict, timeout dopo accettazione, riavvio, TTL, coda piena, 401/403, nuova generazione del client e callback tardivi. Gli intenti scaduti non devono essere riattivati.
4. Verificare offline i confini producer/operator/player, due player concorrenti, perdita heartbeat, doppia tab observer, cancellazione durante sintesi e durante playback, allineamento testo/voce/gesto.
5. Eseguire un collaudo staging di audio reale, lingua, WAV, Rhubarb, microfono virtuale/cattura, accelerazione e flusso RTMP; non basta un `202` o un health check verde.
6. Solo con autorizzazione operativa, inviare una singola narrazione canary nel contesto concordato, verificarne il terminale e l'audio effettivamente ricevuto, poi abilitare il sink nuovo per una quota limitata di rubriche. Fermare l'invio legacy per quegli stessi intenti.
7. Dopo stabilità, estendere alle risposte chat e alla regia legata al job. Tenere separati i rilasci dei prompt editoriali e delle strategie finanziarie.

Metriche consigliate: ultima generazione, ultimo job accettato, ultimo `finished`, età del job più vecchio, numero di job attivi, timeout/401/429, player con lease valido, stato AudioContext, FPS encoder e renderer, progresso audio/video e risultato della trasmissione. Gli alert devono distinguere contenuto non generato, voce non consegnata, player bloccato e streaming fermo, con deduplica e conferma di ripristino stabile; non aggiungere un alert per ogni poll o per ogni preview muta.

## Riferimenti per continuare il lavoro

### Repository locali

- `eliza-air3/agent/src/index.ts`: isolamento del bootstrap Twitch.
- `eliza-air3/characters/AIR3.character.json`: client attivi e identità; contiene riferimenti a segreti, non copiarlo integralmente nei report.
- `eliza-air3/packages/client-twitch/src/client/client.ts`: clock idle, chat, lease e serializzazione.
- `eliza-air3/packages/client-twitch/src/utils/textToSpeech.ts`: sink Gradio attuale.
- `eliza-air3/packages/client-twitch/src/llm.ts` e `characters/prompt/client-twitch/`: modello e prompt scoped.
- `eliza-air3/packages/client-twitch/__tests__/`: casi esistenti su auth, timeout, task tardivi, chat e TTS.
- `eliza-air3/packages/plugin-air-market/src/utils/chartMonitorUpload.ts`: upload grafici condiviso.
- `dapp-air3/src/pages/SponsorPage.tsx`, `src/pages/HomePage.tsx`, `server/src/index.ts`: embed, link e policy frame.
- `ops-snapshots/eliza-air3/2026-08-17-twitch-recovery.md`: recupero precedente e hardening del client; fotografia storica, non configurazione corrente.

### Repository remoto

Sotto `/home/funboy/air3live`:

- `studio-broadcast/src/config.mjs`: limiti e nomi effettivi delle variabili.
- `studio-broadcast/src/gateway.mjs`: endpoint producer/player e risposta effettiva.
- `studio-broadcast/src/live-service.mjs`: gate operator e funzioni della Control Room.
- `studio-broadcast/src/queue.mjs`: hash idempotenza, TTL, retention, claim e stati terminali.
- `studio-broadcast/src/live-settings.mjs`: store persistito e override runtime.
- `studio-broadcast/src/speech.mjs`, `lip-sync.mjs`, `broadcast.mjs`, `encoder.mjs`, `live-process.mjs`: pipeline audio e video.
- `adapters/dapp-wallpanel.mjs`: bridge dati già attivo, con modifica locale da preservare.
- `studio-broadcast/test/gateway.test.mjs`, `live-gateway.test.mjs`, `presentation.test.mjs`, `frontend-player.test.mjs`: specifiche eseguibili da usare per il futuro collaudo isolato.
- `docs/INTEGRATION_CONTRACT.md`, `LIVE_API_3.0.md`, `PRESENTATION_API.md`, `TWITCH_CHAT_3.0.md`, `LIVE_MONITORS.md`: contesto, con le discrepanze segnalate sopra.

### Letture pubbliche e documentazione esterna

Letture effettuate senza attivare il player: [studio pubblico](https://live.airewardrop.xyz/), [configurazione pubblica](https://live.airewardrop.xyz/api/public-config), [programma pubblico](https://live.airewardrop.xyz/api/live/program), bundle JS pubblici dello studio. La pagina pubblica è observer; nessun claim è stato inviato.

Riferimenti primari per il futuro adapter: [Twitch EventSub WebSocket](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/), [autoplay e Web Audio](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), [prevenzione SSRF OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html). EventSub non sostituisce il protocollo producer dello studio e non riproduce gli eventi persi durante una normale disconnessione; deduplica e gestione delle lacune restano responsabilità dei componenti che ne hanno bisogno.
