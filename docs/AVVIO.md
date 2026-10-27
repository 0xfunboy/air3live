> Nota per Live 3.0: il modulo è ora autonomo. Le istruzioni correnti sono [AVVIO_LIVE_3.0.md](AVVIO_LIVE_3.0.md) e [LIVE_API_3.0.md](LIVE_API_3.0.md). Il testo sottostante documenta l’integrazione e le versioni precedenti.

# Avvio e configurazione airewardrop Studio

Questa guida si riferisce al pacchetto `AIR3_Studio_Complete`. Tutti i comandi, salvo indicazione diversa, si eseguono dalla sua radice. Non richiede i vecchi percorsi `C:\AIR3 Refactor` né una cartella `AIR3_Web_Assets` esterna.

AiRewardrop è il marchio aziendale; #AIR3 identifica la presentatrice e lo studio. Nomi di cartelle, API e variabili `AIR3_*` conservano l'identificatore del progetto per compatibilità.

## 1. Installazione e preview locale

Requisiti per l'anteprima: Node.js 24 o successivo, npm e un browser con WebGL2. Installare solo il servizio Studio:

```bash
npm ci --prefix studio-broadcast
npm run preview
```

Aprire `http://127.0.0.1:5892/`. È la preview del personaggio con controllo della camera, clip, espressioni, blink e forme labiali. Il pulsante per ascoltare la voce per **12 secondi** riproduce il campione incluso con allineamento reale già calcolato. Non serve un server TTS per questa prova.

La casella **«Sguardo verso la camera»** è attiva inizialmente. Ruotando la vista si controllano il contatto visivo e la rotazione limitata di collo e testa. Per esaminare un profilo senza che il personaggio segua l'osservatore, disattivare la casella e lasciare assestare la posa. Il controllo **Intensità** parte dal **100%**, con **Leggermente felice** selezionata; gli stati disponibili sono neutra, cordiale, leggermente felice, leggermente triste, concentrata, preoccupata e sorpresa. Il cursore cambia l'intensità senza riavviare l'animazione a ogni evento.

L'acconciatura nuova e le iridi blu sono moduli della resa runtime. Il GLB aperto in un visualizzatore generico non riproduce necessariamente questi materiali o i capelli aggiunti. Le immagini ricevute sono in `source-assets/character_references/`; i PNG originali del marchio sono conservati in `source-assets/branding/`. La distanza interpupillare non è stata cambiata isolatamente: bulbi, palpebre e orbite mantengono la geometria coerente del personaggio.

La preview TV è `http://127.0.0.1:5892/studio`. Per l'uscita pulita e una camera fissa:

```text
http://127.0.0.1:5892/studio?output=1&camera=presenter&quality=high
```

Questo server ascolta solo sul loopback e accetta esclusivamente letture. Non produce narrazioni, non possiede un player della coda e non pubblica video. La sua configurazione non legge `.env`: per scegliere un profilo aggiungere `quality=high`, `balanced` o `software` all'URL. Senza selezione, usa `balanced` su hardware o `software` quando rileva un renderer software.

### Regia, monitor e movimento

Nello studio completo usare la barra **Presenza e movimento**:

1. Scegliere **Monitor sinistro**, **Monitor centrale** o **Monitor destro**.
2. Premere **«Presenta il monitor»** per avviare lo spostamento guidato e il gesto.
3. Premere **«Torna alla postazione»** per il rientro.

Lo sguardo alterna l'attenzione alla destinazione e alla camera, mentre i cambi di camera seguono la regia selezionata. La camminata usa sette catture femminili ACCAD retargettate sul rig della presentatrice. Il controller le combina con i percorsi predisposti e il contatto a terra; non è una navigazione libera. Le clip sono anche selezionabili singolarmente nel menu Movimento della preview.

**«Movimenti automatici»** è disattivato inizialmente. La casella abilita brevi visite ai monitor durante le pause; non richiede che la presentatrice passeggi continuamente mentre parla. Per abilitarlo dall'apertura aggiungere `roam=1`:

```text
http://127.0.0.1:5892/studio?camera=wide&quality=high&roam=1
```

La stessa pagina include **«TEST VOCE & LIP-SYNC»** e il cursore di intensità emotiva inizialmente al 100%. Il campione si può ascoltare anche nella preview TV. Questo pulsante è una prova locale e non prende in carico narrazioni dal gateway.

Il bundle web compilato è incluso in `studio-broadcast/public/build/`. Per ricompilarlo:

```bash
npm run build
```

Non serve compilare i repository Eliza e dApp per avviare lo Studio. L'installazione iniziale delle dipendenze richiede rete; il rendering usa poi asset e librerie locali.

### Luci, capelli, scarpe e preset

Al primo avvio la preview apre con Wavy castano quasi nero (Espresso), maglietta originale e stivaletti con gambale adattato; agli avvii successivi ripristina l'eventuale preset salvato nello stesso browser. La scheda **Aspetto** del pannello **Luci e aspetto** offre tre acconciature, sette colori, due magliette, tre opzioni di calzature e due tagli del gambale. **Volto**, **Scarpe** e **Dietro** aiutano a controllare i dettagli. Il capo corto è disponibile come confronto nel selettore Maglietta. Nel set il pannello si apre dal pulsante della regia.

La scheda **Luci** permette di selezionare uno dei cinque fari e regolarne potenza, azimut, raggio, altezza, bersaglio, cono, penombra, colore e ombre. Ambiente diffuso, IBL ed esposizione sono separati. **Esporta JSON** salva `airewardrop-look.json`. Per fissare il risultato nel broadcaster, sostituire `studio-broadcast/public/assets/air3/presets/default-look.json` con il contenuto del file esportato e riavviare. Una preferenza nel browser personale non modifica da sola un broadcaster con profilo isolato. [Procedura completa](LUCI_E_PRESET.md).

### Avvio su Windows Intel/NVIDIA

Sono conservati i launcher e gli strumenti presenti nel nuovo archivio ricevuto:

```bash
npm run start:intel
npm run start:nvidia
npm run gpu:status
```

I due primi comandi sono alternativi. Si possono usare anche `start-intel.bat` e `start-nvidia.bat` dalla radice. La preferenza DXGI richiede Windows/PowerShell; il browser viene individuato tramite `AIR3_CHROME_PATH`, il valore nel `.env`, il percorso registrato dall'installer o il percorso Windows previsto. La preview prova la porta 5892; se è già occupata sceglie una porta libera, la stampa e apre l'URL corretto, senza arrestare il processo esistente. Su altri sistemi la preferenza Windows non viene applicata e il launcher lo dichiara.

Il launcher conserva il valore precedente della specifica preferenza GPU del browser, incluso il suo tipo, e lo ripristina durante l'arresto regolare. Se un altro processo ha cambiato il valore nel frattempo, conserva quel cambiamento invece di sovrascriverlo. Il percorso dell'eseguibile è passato a PowerShell come dato tramite ambiente, non interpolato in un comando shell.

Rimangono disponibili `npm run gpu:intel`, `npm run gpu:nvidia`, `npm run gpu:reset` e `npm run test:intel`. Per gateway e broadcaster su Windows, dopo la configurazione della sezione seguente, i launcher alternativi sono:

```bash
npm run broadcast:intel
# oppure
npm run broadcast:nvidia
```

Il primo richiede QuickSync (`h264_qsv`), il secondo NVENC (`h264_nvenc`); il supporto effettivo dipende da hardware, driver e build FFmpeg dell'installazione. La selezione richiesta dal launcher non dimostra quale GPU sia stata usata: controllare i log del renderer e dell'encoder.

Il launcher di trasmissione avvia una propria istanza gateway e attende il suo evento `gateway-listening` prima di creare il broadcaster. Se la porta o il database sono già occupati, non arresta né riutilizza silenziosamente il servizio esistente. In quel caso usare i processi standard separati oppure fermare consapevolmente l'istanza precedente.

All'arresto il broadcaster può completare lo scarico degli ultimi pacchetti audio/video mentre il gateway rimane disponibile; soltanto dopo viene fermato il gateway. Su Windows il segnale di chiusura passa tramite un canale IPC riservato ai processi figli, così da eseguire la pulizia asincrona invece di terminare immediatamente Node. Sono previsti timeout finiti e un codice di uscita non riuscita in caso di arresto forzato. I test di questa revisione verificano i meccanismi portabili e il trasporto sicuro degli argomenti, non un accesso reale al registro o alle GPU Windows.

I dati Windows/Intel/NVIDIA in `docs/test-reports/` e le immagini in `docs/renders/intel-arc/` provengono dai collaudi dell'utente sull'archivio ricevuto. Restano distinti dai report della revisione corrente. Questa consegna non implica una nuova prova fisica su quelle GPU.

## 2. Preparare il servizio di broadcasting

Aggiungere FFmpeg e ffprobe al PATH. Per la cattura usare Chrome completo con headless moderno: `chrome-headless-shell` non sostituisce il browser completo richiesto dall'estensione di cattura. Su Linux occorrono anche le librerie di sistema del browser.

```bash
npm run init
npm run browser:install --prefix studio-broadcast
```

`init` crea `studio-broadcast/.env` con token producer e player diversi e non sovrascrive un file esistente. L'installer scarica Chrome for Testing e conserva il percorso per i successivi avvii. In alternativa impostare `AIR3_CHROME_PATH` a un Chrome compatibile del server.

`npm ci` applica la patch inclusa per `puppeteer-stream` 3.0.23: trasporto interno sul loopback, gestione degli errori e rilascio del mutex. La patch verifica la versione attesa. I pacchetti del servizio sono bloccati nel lockfile; un aggiornamento richiede una nuova prova di cattura.

I valori iniziali in `.env.example` sono:

```dotenv
AIR3_HOST=127.0.0.1
AIR3_PORT=5890
AIR3_AVATAR_URL=/assets/air3/models/AIR3-runtime.glb
AIR3_RENDER_QUALITY=high
AIR3_WIDTH=1920
AIR3_HEIGHT=1080
AIR3_FPS=30
AIR3_OUTPUT_MODE=file
AIR3_VIDEO_ENCODER=auto
AIR3_BROADCAST_DURATION_SECONDS=0
```

La risoluzione e i 30 fps sono obiettivi di configurazione. Il log `renderer-final` misura i frame realmente disegnati: un video codificato a 30 fps può includere duplicazioni se il renderer è più lento.

Per un collaudo intenzionalmente in software, impostare nel `.env`:

```dotenv
AIR3_RENDER_QUALITY=software
AIR3_CHROME_ANGLE=swiftshader
AIR3_REQUIRE_HARDWARE_RENDERING=false
AIR3_VIDEO_ENCODER=libx264
AIR3_WIDTH=960
AIR3_HEIGHT=540
AIR3_FPS=15
```

La selezione esplicita `high` rimane `high` anche su SwiftShader. Solo `AIR3_RENDER_QUALITY=auto` permette la selezione automatica del profilo. `balanced` mantiene bloom e riflesso planare ridotto; `high` aggiunge GTAO e aumenta risoluzione delle ombre e del riflesso. Il [documento del rendering](STUDIO_RENDERING.md) descrive gli effetti.

## 3. Gateway, registrazione e audio

Nel primo terminale:

```bash
npm start
```

Il gateway serve API e `http://127.0.0.1:5890/studio`. Il modello corretto e i moduli del nuovo look sono già configurati: non occorre fornire un altro GLB. Una visita manuale è un osservatore che non prende in carico narrazioni; può riprodurre volontariamente il campione locale con il pulsante di prova vocale.

Nel secondo terminale:

```bash
npm run broadcast
```

Il broadcaster apre Chrome headless, attende il caricamento reale dell'avatar e la compilazione del primo frame, arma l'audio e collega il player autorizzato. Cattura audio e video della stessa pagina, poi invia il flusso a FFmpeg. Non richiede OBS, desktop remoto, Xvfb o un monitor fisico.

Il file risultante è un nuovo MKV in `studio-broadcast/recordings/`; i file esistenti non vengono sovrascritti. Per una prova limitata impostare, per esempio, `AIR3_BROADCAST_DURATION_SECONDS=60` prima di avviare il broadcaster. La durata decorre dall'avvio del processo, includendo la preparazione. Il valore `0` mantiene la registrazione continua; terminarla con Ctrl+C o con il supervisore.

`AIR3_CONTROL_STDIN=true` abilita il controllo tramite `quit`/EOF quando un supervisore possiede lo standard input. Mantenerlo falso negli avvii normali. SQLite e i WAV temporanei sono sotto `studio-broadcast/data/`; conservare questa directory su disco locale persistente, senza condividerla fra host.

Senza una narrazione disponibile l'avatar esegue le animazioni di attesa. Per produrre voce occorre configurare il TTS e inviare una richiesta tramite il bridge Eliza o l'API del [contratto d'integrazione](INTEGRATION_CONTRACT.md).

## 4. TTS remoto e allineamento del labiale

Nel `.env` del servizio:

```dotenv
AIR3_TTS_BASE_URL=http://GPU_HOST_PRIVATO:8880/v1
AIR3_TTS_API_KEY=
AIR3_TTS_MODEL=kokoro
AIR3_TTS_VOICE_EN=af_jessica
AIR3_TTS_VOICE_IT=if_sara
AIR3_TTS_SPEED=1
AIR3_TTS_TIMEOUT_MS=60000
AIR3_TTS_CHUNK_CHARS=600
AIR3_LIPSYNC_MODE=auto
AIR3_LIPSYNC_TIMEOUT_MS=45000
AIR3_LIPSYNC_THREADS=2
```

`GPU_HOST_PRIVATO` è un segnaposto. Il provider deve rispondere a POST `/v1/audio/speech` con **WAV PCM16**, mono o stereo, da 8 a 96 kHz. Il gateway richiede `response_format=wav`, valida il contenuto e assembla segmenti compatibili. Un WAV float o compresso non è intercambiabile. Il modello e le voci iniziali sono valori Kokoro; si può usare un altro server che rispetti lo stesso contratto, verificando le sue voci e il formato audio effettivo. Questa revisione non installa un nuovo server TTS e non dichiara un vincitore di efficienza fra modelli non misurati.

La chiave TTS rimane nel gateway. Usare HTTPS se il collegamento attraversa una rete non fidata. La compatibilità API non implica compatibilità con la vecchia API Gradio: configurare l'endpoint corrispondente.

Rhubarb **1.14.0** è incluso in `studio-broadcast/vendor/rhubarb/1.14.0/` per Linux x64 e Windows x64, con licenze upstream. Il servizio analizza il WAV completo prima dello stato `ready`: usa `pocketSphinx` per inglese e `phonetic` per italiano. Restituisce nove forme A–H e X. È un allineamento fonetico approssimato, non una trascrizione perfetta garantita per tutte le lingue o voci.

| Modalità | Se l'allineamento non è disponibile |
|---|---|
| `auto` | Riproduzione con fallback all'ampiezza audio, dichiarato nello stato del player |
| `required` | La narrazione fallisce; utile quando il labiale temporizzato è un requisito del live |
| `off` | Solo ampiezza audio, senza invocare Rhubarb |

`AIR3_RHUBARB_PATH` permette un eseguibile alternativo, necessario per piattaforme non incluse. L'installer non scarica modelli vocali o altri servizi.

La timeline precalcolata del campione incluso di 12 secondi riporta un'analisi di **13,955 secondi sulla CPU usata per quel bake**, in `studio-broadcast/public/assets/air3/demo/voice-reference.json`. È una misura del campione conservato, non un nuovo benchmark del TTS o una promessa per il server finale. Il costo si aggiunge alla sintesi prima della riproduzione; non è garantita un'elaborazione più rapida della durata dell'audio.

Il player campiona la timeline con `AudioContext.currentTime`. Le forme adiacenti vengono miscelate su una finestra continua di 90 ms con anticipo di 14 ms; l'apertura mandibolare è poi modulata dal livello audio reale. Le pause della timeline restano la forma di riposo. Arresto e cancellazione interrompono anche il labiale. Le pose manuali della preview sono invece campioni statici per l'ispezione.

Per un flusso continuativo misurare insieme sintesi, allineamento e durata delle frasi sul server scelto. CUDA sul server TTS, rendering WebGL e NVENC sull'host del broadcaster sono tre capacità indipendenti.

## 5. Collegare Eliza

Il pacchetto conserva il bridge opzionale già presente in `airewardrop-eliza-main/packages/client-twitch/`. Le modifiche originali sono elencate in `patches/CHANGES.json`; questa revisione grafica non aggiunge altre modifiche al repository dell'agente.

Configurare nel processo Eliza, non nel browser:

```dotenv
TWITCH_TTS_ENABLE=true
AIR3_STUDIO_ENABLED=true
AIR3_STUDIO_GATEWAY_URL=http://HOST_PRIVATO_STUDIO:5890
AIR3_STUDIO_PRODUCER_TOKEN=VALORE_DEL_PRODUCER_TOKEN_DEL_GATEWAY
AIR3_STUDIO_LANGUAGE=en
AIR3_STUDIO_TIMEOUT_MS=160000
```

Host e token sono segnaposto. Avviare TTS, gateway e broadcaster prima di attivare il ramo Studio. `TWITCH_TTS_ENABLE` resta l'interruttore generale. Con `AIR3_STUDIO_ENABLED=false` torna il percorso precedente; quando il ramo Studio è attivo, un errore non attiva una seconda voce in automatico.

Il bridge attende lo stato `finished`, quindi include sintesi, allineamento, attesa in coda e riproduzione nel suo budget. Il default di 160 secondi va rispettato con testi sufficientemente brevi; `AIR3_NARRATION_TTL_MS` del gateway deve essere almeno altrettanto lungo, e vale inizialmente 300000 ms. L'estensione dell'allineamento può rendere necessario accorciare i segmenti editoriali, senza cambiare il contratto dell'agente.

Il gateway ascolta sul loopback. Per un Eliza remoto scegliere l'interfaccia privata con `AIR3_HOST`, oppure un reverse proxy HTTPS, mantenendo il producer token solo sui server. Il player token è distinto e resta al broadcaster.

L'API accetta facoltativamente `emotion` con `name` fra `neutral`, `warm`, `happy`, `sad`, `focused`, `concerned`, `surprised` e `intensity` da 0 a 1, predefinita a 0,35. `GET /api/emotions` e `GET /api/expressions` espongono i nomi canonici e gli alias italiani sia nel gateway sia nella preview. Il bridge legacy non inferisce automaticamente l'emozione dal testo. Quando il producer omette il campo, la nuova pagina mantiene l’espressione scelta dalla regia anche durante il parlato. Il claim espone il campo additivo `emotionExplicit`: distingue una richiesta esplicita dal vecchio valore neutro di compatibilità, senza migrare il database o cambiare gli hash delle richieste.

Un producer può aggiungere alla stessa richiesta un comando opzionale di presentazione:

```json
{
  "id": "commento-grafico-001",
  "text": "Osserviamo il grafico sul monitor destro.",
  "language": "it",
  "emotion": { "name": "focused", "intensity": 0.3 },
  "presentation": { "action": "monitor", "monitor": "right" }
}
```

I monitor ammessi sono `left`, `center`, `right`; `{"action":"home"}` richiede il rientro. Omettere il campo per conservare il comportamento precedente. Le altre forme, incluso `null`, vengono rifiutate. Il comando viaggia con il lease vocale e viene applicato una volta all'avvio del job: non è una marcatura di una parola e non ritarda il suono fino all'arrivo al monitor. La migrazione della coda mantiene gli hash d'idempotenza precedenti quando il campo manca. Non è necessario modificare l'agente per mantenere la funzione precedente; un'integrazione che desidera comandare i gesti deve inviare esplicitamente il nuovo campo. Dettagli in [PRESENTATION_API.md](PRESENTATION_API.md) e nel [contratto](INTEGRATION_CONTRACT.md).

## 6. Alimentare i monitor

Impostare `AIR3_DAPP_BASE_URL` all'origin del backend pubblico esistente, oppure alla sua base `/api`. La pagina offre `feed=track` per AIRTrack e `feed=auto` per auto-trading. Grafici, report e posizioni usano i dati di quel backend; i due flussi restano etichettati.

Non occorre avviare la copia dApp inclusa. Il suo backend può contenere worker operativi: per lo Studio basta l'URL del servizio già gestito dall'utente. La nuova UI legge le API e riceve notifiche dal WebSocket pubblico; il canale non viene riutilizzato per comandi dell'avatar o ordini. I grafici sono canvas locali su texture Three.js, senza iframe.

L'età dei dati e lo stato della connessione sono visibili. Quando l'URL non è configurato o una risposta manca, i monitor mostrano tale condizione. La freschezza rimane limitata anche dalle cache del backend sorgente. Gli endpoint legacy possono eseguire il proprio backfill; questa integrazione non aggiunge richieste di trading o scrittura.

## 7. Uscita RTMP o RTSP

Per una destinazione RTMP/RTMPS:

```dotenv
AIR3_OUTPUT_MODE=rtmp
AIR3_RTMP_URL=rtmps://INGEST_FORNITO_DALLA_PIATTAFORMA/app
AIR3_RTMP_KEY=CHIAVE_DELLA_TRASMISSIONE
AIR3_VIDEO_ENCODER=auto
AIR3_REQUIRE_HARDWARE_RENDERING=true
AIR3_BROADCAST_DURATION_SECONDS=0
```

Usare l'indirizzo indicato dalla piattaforma. La chiave viene aggiunta al percorso: non duplicarla se è già compresa nell'URL. Per RTSP serve un server ricevente, per esempio MediaMTX configurato per accettare il percorso:

```dotenv
AIR3_OUTPUT_MODE=rtsp
AIR3_RTSP_URL=rtsp://HOST_MEDIAMTX:8554/air3
AIR3_REQUIRE_HARDWARE_RENDERING=true
AIR3_BROADCAST_DURATION_SECONDS=0
```

FFmpeg pubblica via RTSP su TCP. L'uscita usa H.264 e AAC stereo a 48 kHz; RTMP usa contenitore FLV, la registrazione locale Matroska. Il processo fornisce una destinazione alla volta. Eventuali relay multipli si configurano a valle.

`AIR3_VIDEO_ENCODER=auto` prova realmente `h264_nvenc`, poi `h264_qsv`, infine `libx264`. Il log `encoder-selected` indica quello usato. `renderer-ready` indica invece il renderer grafico: NVENC disponibile non dimostra WebGL accelerato, e viceversa. Con `AIR3_REQUIRE_HARDWARE_RENDERING=true` il broadcaster rifiuta un renderer software. Su Linux senza display il backend ANGLE dipende da GPU e driver: configurare `AIR3_CHROME_ANGLE` sulla base di quella prova, non del solo fatto che CUDA funzioni.

La cattura passa attraverso WebM VP8/Opus e viene transcodificata da FFmpeg. È una pipeline headless completa, non un percorso GPU diretto senza copie o ricodifica. L'assenza del desktop non elimina il costo del rendering e della codifica.

## 8. Servizi automatici e collaudo sul server finale

I template `studio-broadcast/deploy/air3-gateway.service` e `air3-broadcast.service` usano `/opt/air3/studio-broadcast`, utente `air3` e `/usr/bin/node`. Adeguare percorsi e utente all'installazione e provare prima i comandi manuali. Non installano software né pubblicano da soli una trasmissione. Eseguire Chrome con il sandbox attivo come utente non root; `AIR3_CHROME_NO_SANDBOX=false` è il default.

Gateway e broadcaster sono processi separati. I riavvii del broadcaster hanno limite e backoff. La coda usa lease e heartbeat per evitare due player contemporanei; un riavvio non costituisce una garanzia di ripetizione completa della frase interrotta.

Dalla radice:

```bash
npm run verify --prefix studio-broadcast
node studio-broadcast/scripts/qa-attention.mjs
npm run smoke
npm run smoke:avatar
npm run qa:logs --prefix studio-broadcast
npm run qa:visual --prefix studio-broadcast
```

Le smoke test usano gateway temporanei, non il TTS remoto o una piattaforma live. La prima impiega un tono di calibrazione; la seconda carica l'avatar reale, usa i 12 secondi di voce inclusi e ricalcola la timeline con Rhubarb nativo. `AIR3_QA_DIR` permette di conservare i risultati in una cartella scelta e `AIR3_QA_SOFTWARE=true` richiede la prova in software. In PowerShell impostare le variabili con `$env:NOME='valore'`; in bash con `export NOME=valore` prima del comando.

`qa:logs` esporta suite, sintassi, build e ambiente sotto `docs/validation/current/`; `qa:visual` acquisisce il rendering del bundle compilato con il modello reale. Richiede il browser installato o `AIR3_CHROME_PATH`; anche per questi strumenti `AIR3_QA_DIR` può scegliere la destinazione. `qa-attention.mjs` verifica invece gli assi oculari sul rig reale in Node, senza pretendere una misura della resa fotografica.

I conteggi e gli esiti correnti sono nei JSON e nella [validazione](VALIDAZIONE.md). I dati importati Intel/RTX 5090 appartengono alla versione testata dall'utente: questa revisione non promette 1080p30 o 1080p60 su quelle GPU senza misura. Prima dell'esercizio continuo restano da verificare sull'host scelto ritmo di rendering, risorse, latenza vocale, stabilità prolungata e destinazione live.

La nuova acconciatura è una ricostruzione web, non il groom fisico Unreal; il vestito non ha simulazione cloth. Il volto segue i riferimenti come direzione estetica, senza dichiarare un clone fotografico. Per la qualità effettivamente osservata usare le acquisizioni della stessa revisione, non i frame storici di un modello diverso.
