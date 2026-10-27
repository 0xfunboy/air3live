# #AIR3 Live 3.0 — avvio e prima trasmissione

Revisione: 27 ottobre 2026. Questa guida riguarda il modulo autonomo contenuto in questo archivio.

## Cosa avvii

`npm run live` apre il servizio di regia. Il terminale stampa l'indirizzo della console, normalmente **http://localhost:5890/control**. Il pulsante **LIVE** avvia successivamente il renderer e l'invio video; aprire la console o riavviare il servizio non mette il canale in onda.

La trasmissione usa Chromium headless per la scena Three.js e il suo audio, poi FFmpeg per H.264/AAC e l'uscita RTMP/RTMPS. Può funzionare su un server senza desktop interattivo e senza OBS. Il server deve comunque avere driver e accesso effettivo alla GPU per una diretta: la presenza di CUDA o di NVENC, da sola, non dimostra che WebGL stia usando la GPU.

dApp ed Eliza non servono per avviare il modulo. Un agente può continuare a inviare testi, titoli e snapshot del wallpanel attraverso le API descritte in [LIVE_API_3.0.md](LIVE_API_3.0.md). Il server TTS può stare su un'altra macchina con GPU ed essere raggiunto via HTTP(S).

## 1. Installazione

Servono:

- Node.js **24 o successivo**, con npm.
- FFmpeg disponibile nel `PATH`, oppure il percorso del suo eseguibile in `AIR3_FFMPEG`.
- Il browser installato dal comando di setup, oppure un percorso valido in `AIR3_CHROME_PATH`.
- Per LIVE: GPU esposta al processo di Chromium e driver adatti al sistema operativo. Nei container devono essere accessibili sia il rendering grafico sia l'encoder scelto.

Estrai l'archivio in una cartella scrivibile. Dal terminale aperto nella cartella con il `package.json` principale:

```bash
node --version
ffmpeg -version
npm run setup
npm run live
```

Il setup installa le dipendenze del servizio, inizializza la configurazione se manca e scarica Chrome for Testing. Il primo setup richiede Internet. Su Linux possono essere necessarie le librerie di sistema richieste da Chromium; un errore relativo a una libreria condivisa va risolto sul sistema prima di avviare il renderer.

Dopo il setup puoi usare anche **`start-live.bat`** su Windows oppure **`./start-live.sh`** su Linux/macOS. Questi launcher eseguono la stessa regia. Non sono un installer di Node, FFmpeg o dei driver GPU. Per aggiornare solo il browser:

```bash
npm run browser:install --prefix studio-broadcast
```

## 2. Configurazione conservata e accesso alla regia

La configurazione di servizio si trova in `studio-broadcast/.env`. Al primo avvio vengono generate tre chiavi distinte:

| Chiave | Uso |
| --- | --- |
| `AIR3_OPERATOR_TOKEN` | Accesso alla regia e ai comandi di avvio/arresto. |
| `AIR3_PRODUCER_TOKEN` | Pubblicazione di testi, titoli, wallpanel e messaggi esterni da un agente. |
| `AIR3_PLAYER_TOKEN` | Comunicazione interna del player con la coda audio. |

Il launcher conserva una `.env` già presente, compresi i token e i parametri TTS. Aggiunge il token operatore solo se manca e abilita il modulo live. Non rigenera le credenziali già utilizzate dalle integrazioni.

Dal computer che esegue il servizio, la regia consente l'accesso locale su `127.0.0.1`, `localhost` o `::1`. L'autenticazione crea una sessione; non inserisce il token nell'URL. La scorciatoia locale non vale per una richiesta proveniente da un'altra macchina.

Le impostazioni salvate dai pannelli — destinazione, voce, mercato e chat — sono in `studio-broadcast/data/live-settings.json`, oppure nella directory indicata da `AIR3_DATA_DIR`. Su sistemi POSIX il file usa permessi `0600`; contiene le credenziali server e non è servito al browser. Le letture API restituiscono soltanto indicatori come `hasKey` e `authorized`. Per un backup del server conserva `.env` e la directory dati in un luogo privato.

## 3. Prima prova locale, con audio

1. Apri `/control`. In **Destinazione** lascia il profilo **1080p30**, oppure scegli **720p30** per il primo collaudo del server. I profili sono obiettivi di uscita; le metriche effettive vanno controllate durante la sessione.
2. Premi **Verifica encoder**. Il servizio prova un'encode reale di pochi frame e controlla la presenza di FFmpeg e Chromium. La verifica del renderer GPU avviene quando si avvia la sessione.
3. Premi **Registra prova**. Non serve una stream key: il file viene scritto localmente in `data/recordings/`.
4. In **Voce**, premi **Test audio incluso**. Questo usa la traccia di collaudo presente nel pacchetto e permette di verificare audio, riproduzione e lipsync senza un server TTS.
5. Imposta un titolo, cambia camera e prova **Vai al monitor** / **Torna al centro**. I comandi di movimento e test audio richiedono una registrazione o una diretta attiva.
6. Premi **Arresta** e apri il file MKV dalla scheda **Verifiche**. Controlla il file registrato, oltre alla miniatura della regia: la miniatura viene aggiornata su richiesta ed è limitata a un'acquisizione ogni tre secondi.

Per ispezionare lo studio quando il broadcaster è fermo, usa il collegamento a `/studio`. Questa pagina di ispezione non avvia l'uscita streaming. `npm run preview` resta disponibile per la sola anteprima grafica.

La registrazione locale consente il rendering software per il collaudo su macchine senza GPU. Una registrazione riuscita con SwiftShader non certifica il funzionamento in tempo reale o le prestazioni del server di produzione. **LIVE richiede un renderer hardware verificato.** L'encoder `auto` prova NVENC, poi QSV e infine libx264; un encoder scelto esplicitamente deve superare la sua prova, senza sostituzioni silenziose.

## 4. Diretta tramite Restream

1. In Restream crea o seleziona uno stream **Encoder | RTMP**, abilita i canali desiderati e imposta titolo/categoria della trasmissione sulla piattaforma.
2. Copia **Server URL** e **Stream Key**. Restream offre anche l'URL RTMPS: usa quello indicato nel tuo pannello.
3. Nella scheda **Destinazione** della regia scegli **Restream**, incolla il server nel campo URL e la chiave nel campo password separato. Non concatenare la chiave all'URL del server.
4. Seleziona profilo, bitrate e encoder; premi **Salva destinazione**. Il valore iniziale è 1080p30 a 4500 kbit/s, modificabile in base alla rete e al canale.
5. Premi **● LIVE**. Attendi che il servizio riceva progressi reali dall'encoder e che Restream mostri il flusso in ingresso. Controlla anche il canale finale: la sola accettazione del comando non dimostra che Restream abbia pubblicato su tutte le destinazioni.
6. Per terminare premi **■ Arresta**. Attendi la conferma di arresto prima di cambiare endpoint o chiave.

Per inviare il video a Restream bastano URL e chiave; questo modulo non richiede un OAuth Restream. L'autorizzazione dei canali collegati e la gestione della destinazione restano nel tuo account Restream. La titolazione della scena è un elemento del video, mentre titolo/categoria pubblicati sulle piattaforme sono metadati distinti.

Riferimenti ufficiali: [Streaming software con Restream](https://support.restream.io/en/articles/6505602-go-live-with-streaming-software) e [uscita RTMPS](https://support.restream.io/en/articles/8523770-encrypt-your-stream-with-rtmps).

## 5. Twitch diretto e chat Twitch

Per l'invio video diretto scegli **Twitch** e inserisci il server ingest e la stream key del tuo canale. Il pulsante **Test banda Twitch · non pubblico** usa la modalità `bandwidthtest=true`; il test è specifico per l'endpoint Twitch e non equivale a una diretta su Restream. Vedi la [documentazione di broadcasting Twitch](https://dev.twitch.tv/docs/video-broadcast/).

La chat si configura separatamente e può essere letta anche quando il video viene inviato a Restream:

1. Registra un'app nella console sviluppatori Twitch e copia Client ID e Client Secret.
2. Registra come redirect OAuth l'indirizzo esatto mostrato nella scheda **Chat**, con percorso `/api/live/twitch/callback`. Host, protocollo e porta devono coincidere con quelli da cui apri la regia.
3. Inserisci il login del canale, Client ID e Client Secret; abilita la lettura, salva e premi **Collega con Twitch**.
4. Completa l'autorizzazione nel browser. Il servizio richiede `user:read:chat`, gestisce token e riconnessione EventSub lato server e mostra i messaggi nella regia.

Con la configurazione locale predefinita apri la regia da `http://localhost:5890/control` e registra **`http://localhost:5890/api/live/twitch/callback`**. Questa scelta segue il nome host HTTP usato esplicitamente nella [guida ufficiale Twitch](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/). Mantieni lo stesso host durante login, autorizzazione e ritorno OAuth: `localhost` e `127.0.0.1` sono origini web differenti anche quando raggiungono lo stesso servizio. Il bind del gateway e il collegamento interno del renderer rimangono su `127.0.0.1`; non serve cambiarli per il callback.

La chat viene letta. I messaggi non vengono pronunciati automaticamente e non diventano comandi del personaggio. Il modulo non invia risposte in chat. La chat aggregata di Restream richiede un bridge verso `POST /api/live/chat/ingest`; non è inclusa un'autenticazione nativa alla chat multi-piattaforma Restream. Configurazione e limiti sono descritti in [TWITCH_CHAT_3.0.md](TWITCH_CHAT_3.0.md).

## 6. Voce, emozione e titoli

In **Voce** configura un server compatibile con la richiesta OpenAI `POST /v1/audio/speech`, con risposta WAV, modello, nomi delle voci italiano/inglese e API key se richiesta. Puoi mantenere il tuo server Kokoro oppure sostituirlo con un'implementazione compatibile. Non è necessario spostare il TTS sullo stesso host del renderer.

Il testo entra nella coda persistente, viene sintetizzato e riprodotto nel renderer. Le forme della bocca seguono il tempo di riproduzione dell'audio. `AIR3_LIPSYNC_MODE=auto` usa l'allineamento disponibile; `required` richiede l'allineatore funzionante, `off` lo disabilita. La presenza del test audio nel pacchetto non equivale a una prova riuscita del tuo endpoint TTS: prova anche un testo italiano ed uno inglese con le voci configurate.

La scena parte da **Leggermente felice, 100%**, contatto visivo attivo, off shoulder bianco crema e i preset grafici inclusi. La correzione delle spalle durante il parlato è documentata in [PARLATO_E_SPALLE.md](PARLATO_E_SPALLE.md). Per applicare un'espressione a uno specifico intervento, l'API della narrazione accetta `emotion`.

In **Titoli** imposta etichetta, titolo, sottotitolo e righe del ticker. `TTL = 0` mantiene la titolazione fino alla successiva modifica; un valore positivo la disattiva dopo quel numero di secondi, anche dopo un riavvio. Il campo scorrevole non è una chat pubblica: contiene i testi editoriali inseriti dall'operatore o dal produttore autorizzato.

## 7. Monitor centrale e heatmap destra

Il centrale mostra il wallpanel; il destro la heatmap; il sinistro il riepilogo mercato e l'intervento corrente. La scheda **Monitor** permette di cambiare fonte, simbolo, finestra e origine del wallpanel.

| Fonte heatmap | Significato |
| --- | --- |
| Binance | Liquidazioni effettivamente osservate nel feed pubblico, raccolte da quando il servizio si connette. Campione incompleto, non livelli futuri. |
| CoinGlass Model3 | Livelli stimati dal modello ufficiale, con chiave e piano API abilitati. |
| Demo | Dati sintetici esplicitamente etichettati, utili per verificare la grafica senza rete. |

Il sistema non passa alla demo quando una fonte reale smette di rispondere. Stato, provenienza ed età del dato vengono mantenuti visibili. La disponibilità del feed Binance va verificata dalla rete del server: nel collaudo di questo ambiente il probe reale è fallito per connessione; non è stata utilizzata una chiave CoinGlass a pagamento.

Per usare il contenuto AIRTrack già esistente seleziona **Wallpanel esterno** e invia lo snapshot al suo endpoint. La dApp non viene incorporata in un iframe e non è necessaria per il funzionamento autonomo. Schema, semantica e limiti delle fonti sono in [MONITOR_LIVE.md](MONITOR_LIVE.md).

## 8. Regia remota sul tuo server

Per aprire la regia da un altro computer, configura un reverse proxy HTTPS verso il gateway e imposta in `.env`:

```dotenv
AIR3_HOST=127.0.0.1
AIR3_PORT=5890
AIR3_PUBLIC_ORIGIN=https://regia.example.com
AIR3_LOCAL_OPERATOR=false
```

L'esempio presume che il reverse proxy sia sullo stesso host. `AIR3_PUBLIC_ORIGIN` contiene solo l'origine, senza percorso aggiuntivo. Il proxy deve rendere disponibili `/control`, `/studio` e le API dalla stessa origine. Accedi con il valore di `AIR3_OPERATOR_TOKEN` conservato sul server; non metterlo nell'URL, nei sorgenti del frontend o nel payload dei monitor. La sessione web HTTPS usa un cookie HttpOnly, SameSite e Secure.

Se il proxy si trova su un host o container separato, configura l'ascolto su un'interfaccia raggiungibile dal proxy e mantieni la porta del gateway nel perimetro privato. Il renderer continua a collegarsi localmente al gateway; non usa il dominio pubblico come destinazione della cattura. L'origine pubblica determina anche il callback OAuth Twitch, che va aggiornato nella sua applicazione registrata.

## 9. Arresto, log e problemi comuni

**Arresta** termina la sessione di registrazione/streaming, lasciando aperta la regia. `Ctrl+C` nel terminale arresta il servizio e il broadcaster che possiede; non chiude un'altra istanza già in esecuzione. Il servizio non riparte automaticamente in LIVE dopo un riavvio.

| Segnale | Controllo utile |
| --- | --- |
| `BROWSER_NOT_INSTALLED` | Esegui `npm run browser:install --prefix studio-broadcast` oppure verifica `AIR3_CHROME_PATH`. |
| `FFMPEG_NOT_AVAILABLE` | Verifica `ffmpeg -version` nello stesso ambiente dell'account che esegue il servizio. |
| `ENCODER_PROBE_FAILED` | Controlla driver e disponibilità dell'encoder richiesto; prova una registrazione con `libx264` per isolare il problema. |
| Renderer software durante LIVE | Rendi la GPU disponibile a Chromium e verifica la metrica RENDER; abilitare NVENC risolve solo la codifica. |
| `STREAM_DESTINATION_REQUIRED` | Salva server e stream key nei due campi separati. |
| `STOP_BEFORE_STREAM_SETTINGS` | Ferma la sessione prima di modificare destinazione, chiave o profilo. |
| `BROADCAST_STOP_TIMEOUT` | L'uscita del processo non è stata confermata. Il servizio mantiene la proprietà del processo e blocca un nuovo avvio; controlla i processi dell'istanza prima di riavviare. |
| Porta occupata | Usa la regia già avviata oppure assegna un'altra porta; il launcher non termina il processo estraneo. |
| Chat autorizzata ma scollegata | Controlla stato, canale e callback; se cambi Client ID o Secret, ripeti l'autorizzazione. |
| Heatmap vuota/non aggiornata | Controlla provenienza, rete e intervallo di raccolta; nessun evento osservato non significa necessariamente errore. |

Le metriche dell'encoder e del renderer sono distinte. La dicitura “running” richiede progressi del flusso, ma non certifica i 60 fps di rendering o la pubblicazione della piattaforma finale. Eventi e registrazioni sono disponibili nella regia; `data/live-session.log` conserva eventi con credenziali e destinazioni di streaming redatte.

## Verifiche disponibili nel pacchetto

`docs/validation/current/live-boundary-tests.txt` registra **34/34 test locali** su configurazione, permessi, sessioni, origini, conservazione delle chiavi, launcher, annullamento del preflight, stop e redazione dei log. Questi test includono processi e reti controllati; non dichiarano una diretta Twitch/Restream o un OAuth reale riusciti. I report grafici, di animazione e di registrazione della consegna sono nella stessa directory `docs/validation/current/` e vanno letti con i rispettivi limiti di hardware e ambiente.

`node scripts/qa-live-launcher.mjs` è stato eseguito anche con il **gateway locale reale**: sette controlli superati su URL stampato, nessun avvio automatico della trasmissione, feed esterni disabilitati, sessione loopback, callback locale coerente con l'origine della sessione, porta occupata senza interrompere l'istanza precedente e arresto ordinato del gateway posseduto. Report e hash dei sorgenti: `docs/validation/current/live-launcher/report.json`. Questo collaudo usa dati temporanei e non avvia Chromium, un encoder o un'autorizzazione su Twitch.

La prima verifica sul tuo canale resta: registrazione locale con voce, controllo GPU e fps sul server, ricezione in Restream/Twitch, controllo del canale finale e arresto confermato. Non sono necessarie modifiche alla dApp o ad Eliza per completare questa prova.
