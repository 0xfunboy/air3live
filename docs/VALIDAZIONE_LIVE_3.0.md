# #AIR3 Live Standalone 3.0: validazione della consegna

**27 ottobre 2026 · pacchetto 3.0.0 · servizio broadcast 1.0.0**

Il modulo standalone è stato compilato e verificato localmente, inclusi una sessione con il browser headless, voce e lip-sync, registrazione H.264/AAC e invio RTMP a un ricevitore locale. Questa validazione distingue le prove completate dai collaudi che richiedono account e GPU dell'ambiente di destinazione.

## Esito sintetico

| Verifica | Risultato misurato |
| --- | --- |
| Suite completa | **216 test passati, 0 fallimenti, 0 saltati**, circa 15,74 s |
| Sintassi | **132 moduli JavaScript**, 0 errori |
| Build frontend | 6 output compilati e 98 asset inventariati, hash SHA-256 verificati |
| Gateway + regia + renderer compilato | **8 controlli completi passati**, nessun errore JavaScript/console/HTTP rilevato |
| glTF Validator | **6 GLB**, 0 errori, 8 avvisi |
| Invio/ricezione RTMP | **3 controlli passati**, 240 frame ricevuti in 8,021 s, H.264 720p + AAC stereo 48 kHz |
| Launcher reale | **7 controlli passati**, inclusi origine localhost e callback coerenti, stop e porta già occupata |
| Maglia | 6 test specifici e 24 viste di controllo, incluse pose parlato/camminata |
| Spalle talk | 3.731 campioni a 60 Hz e 16 viste comparative |
| Monitor | 19 test specifici e 15 render canvas di cinque scenari |
| Twitch chat | 18 test con trasporto/API simulati dichiarati |
| Bridge dApp | 11 test, incluso rifiuto dei redirect con server HTTP reale locale |

I gruppi specialistici della tabella sono già compresi, ove applicabile, nella suite completa: non vanno sommati ai 216 per inventare un totale più alto. Il browser è Chrome for Testing 148, Node v24.22.1. L'ambiente esegue il rendering software SwiftShader e l'encoder CPU libx264.

## Presentatrice

### Maglia off shoulder

Il preset predefinito seleziona il top adattato. La misura finale, dopo il fit, è **13,45% più corta** in verticale. L'orlo è rialzato di **41,56 mm**; l'ancoraggio superiore si sposta di circa **0,016 mm**. La variazione verticale del bordo frontale centrale scende da **14,35 a 0,99 mm** nella posa di riferimento. La rettifica locale della scollatura evita di pretendere che una semplice scala verticale elimini automaticamente la W.

Le pieghe del busto sono rialzate insieme al tessuto. L'avatar mantiene la propria geometria. Topologia e UV della maglia sorgente sono conservate; i pesi sono ricalcolati e normalizzati. Il materiale bianco attenua il grigio originale e introduce sottotoni crema/lilla tenui con trama procedurale filtrata. La maglia non è emissiva e resta influenzata dall'illuminazione.

La procedura di conversione produce lo stesso GLB byte per byte. Hash del top:

`a7f45020f75d775a79ead6b1b8006f4ee89cc3f4ada3251efcebe6e4fd3735d7`

La verifica visiva include davanti, lato, retro, parlato e due fasi della camminata. Non è una certificazione di assenza di intersezioni per qualsiasi futura animazione; non è presente un simulatore cloth generale.

### Spalle nel parlato

La correzione misura l'altezza della spalla rispetto al collo, ruota morbida la clavicola e compensa l'omero. Non allunga ossa o collo, non cambia le proporzioni e non blocca la gestualità.

| Animazione | Cedimento massimo prima | Dopo |
| --- | ---: | ---: |
| MH_Talk | 11,725 mm | 7,190 mm |
| MH_Talk01 | 43,148 mm | 8,000 mm |
| MH_Talk02 | 28,418 mm | 7,987 mm |
| MH_Talk03 | 32,767 mm | 7,996 mm |

I valori riguardano il peso talk pieno prima dello strato di movimento. Nei campioni sono nulle le differenze delle scale/traslazioni ossee e delle posizioni della parte inferiore del corpo. La differenza massima nell'orientamento del gesto braccio/gomito/polso è inferiore a `9e-8` radianti. Le mani seguono lo spostamento dell'attacco della spalla; non sono bloccate a una posizione assoluta.

## Prova completa del prodotto compilato

Il test usa un gateway reale con directory dati isolata, browser reale, bundle distribuito, coda SQLite, allineamento Rhubarb, cattura audio/video e processo FFmpeg. Il provider TTS della prova restituisce il WAV incluso: questa scelta verifica tutta la riproduzione, ma non misura un modello TTS esterno.

Sono stati controllati:

1. Login locale nella regia, default richiesti e assenza di un secondo renderer 3D nel pannello.
2. Layout desktop e viewport mobile da 390 px.
3. Salvataggio della titolazione dalla UI e assenza di credenziali nello snapshot pubblico.
4. Top bianco predefinito, monitor demo etichettati e titoli nella scena compilata; contenuto HTML trattato come testo inerte.
5. Avvio tramite **Registra prova** di Chromium senza `DISPLAY` e dell'encoder reale.
6. Narrazione tramite Web Audio/Rhubarb, completamento e mantenimento del default «Leggermente felice 100%».
7. Test audio incluso tramite comando alla sessione e rilascio/ripresa corretta del player esclusivo.
8. Arresto senza terminazione forzata, processo figlio con uscita 0, file decodificabile e voce non silenziosa.

Il file ottenuto dura **45,994 s**, pesa **14.175.343 byte** e contiene **H.264 1280×720 a 30/1 fps nominali**, **AAC 48.000 Hz stereo**. La decodifica dell'audio rileva 1.152.737 campioni non silenziosi e picco PCM 18.743.

### Limite di prestazioni della prova

Il renderer disponibile era **SwiftShader**, non una GPU CUDA. Prima dello stop la telemetria indicava **1 fps reale di rendering** e circa **26,87 fps di encoding**. FFmpeg duplica frame per rispettare la cadenza del video. Il file nominale a 30 fps non dimostra quindi un movimento fluido a 30 fps. Questa è una verifica funzionale e della catena audio/video; la sostenibilità di 1080p30/60 deve essere misurata sulla GPU di destinazione. La modalità LIVE richiede un renderer hardware; la registrazione locale ammette software per consentire questi collaudi.

Durante la prima esecuzione era emersa una CSP che bloccava il caricamento delle immagini incorporate nei GLB via URL `blob:`. È stata corretta la direttiva di connessione del gateway, quindi l'intera prova è stata ripetuta con successo. Nel report corrente non risultano errori di console, pagina o HTTP. Il problema e la sua correzione non sono stati nascosti dietro un risultato parziale.

## Trasporto RTMP

La registrazione reale del test precedente è stata inviata a un processo FFmpeg in ascolto **esclusivamente su 127.0.0.1**, con i parametri dell'encoder di produzione. Si sono mantenuti H.264, AAC, stereo 48 kHz, 720p e GOP di due secondi.

Il ricevitore ha scritto **240 frame in 8,021 s**, per 2.542.608 byte. La voce ricevuta è stata decodificata: picco PCM 18.280 e 99.381 campioni non silenziosi. Publisher e receiver sono usciti con codice 0. Alla chiusura volontaria del publisher FFmpeg ha scritto due messaggi `Input/output error` di fine input; sono conservati nel report. Il controllo verifica anche durata, numero di frame e decodifica, quindi non considera il solo exit code sufficiente.

Questo è un collaudo di protocollo locale. Non è una pubblicazione Restream/Twitch, una prova TLS RTMPS o un benchmark hardware.

## Fonti dei monitor e account esterni

La connessione ai provider mercato non era disponibile dalla rete di verifica: il probe documenta errori DNS `EAI_AGAIN`. Sono stati controllati parsing, riconnessioni, scadenze, persistenza, protezione dei token e rendering con fixture dichiarate. La prova completa sceglie esplicitamente Demo e mostra tale etichetta; non presenta dati inventati come quotazioni correnti.

La heatmap Binance gratuita rappresenta liquidazioni osservate nel flusso campionato, non i livelli predittivi Model3. La cronologia parte dalla raccolta locale e viene conservata fino ai limiti documentati. CoinGlass Model3 usa l'API ufficiale, richiede una chiave e un piano Professional/Enterprise. DefiLlama Liquidations non è stata usata come API gratuita equivalente.

Twitch chat include il flusso Authorization Code, refresh/validazione token, EventSub, reconnect, deduplicazione e cancellazione messaggi. Le prove non usano un account reale. La chat aggregata Restream è un ingresso via API, non una connessione OAuth nativa implementata.

Restano da verificare sul sistema dell'utente:

- Raggiungibilità e autorizzazione del proprio endpoint TTS, voci italiano/inglese e latenza.
- Accesso WebGL hardware da Chromium headless e funzionamento NVENC/QSV.
- Frame rate effettivo, temperature, memoria e stabilità di una sessione prolungata.
- Ricezione del flusso e pubblicazione del canale Restream/Twitch, eventuale RTMPS.
- OAuth reale Twitch e messaggi del canale configurato.
- Raggiungibilità delle API mercato e, se usato, del backend dApp per il wallpanel originale.

Non sono dichiarate parità pixel per pixel con Unreal, prestazioni 24/7 o test con credenziali mai fornite.

## Evidenze nel pacchetto

| Evidenza | Percorso |
| --- | --- |
| Risultati completi e ambiente | `docs/validation/live-3.0/system-qa-report.json` |
| Log test, sintassi e build | `docs/validation/live-3.0/studio-tests.txt`, `check-results.txt`, `build-results.txt` |
| Regia + renderer + cattura | `docs/validation/live-3.0/compiled-live/report.json` |
| Immagine esportata dalla scena | `docs/validation/live-3.0/compiled-live/studio-canvas.png` |
| RTMP | `docs/validation/live-3.0/rtmp-loopback.json` |
| Sei GLB | `docs/validation/live-3.0/imported-assets-validator.json` e report individuali |
| Maglia | `docs/validation/live-3.0/wardrobe-refinement/` |
| Spalle talk | `docs/validation/current/talk-shoulders-report.json` e `talk-shoulders/` |
| Monitor e rete | `docs/validation/current/live-market/` |
| Launcher e origine OAuth | `docs/validation/current/live-launcher/` |
| Gateway/accesso/titoli | `docs/validation/live-3.0/live-gateway-report.json` |
| Chat Twitch | `docs/validation/live-3.0/twitch-chat-report.json` |
| Adattatore dApp | `docs/validation/live-3.0/dapp-bridge-report.json` |
| Gate e esclusioni ZIP | `docs/validation/live-3.0/package-gates-self-test.json` |

I sei GLB hanno zero errori. Gli otto avvisi `NODE_SKINNED_MESH_NON_ROOT` riguardano mesh con skinning non collocate alla radice della scena: sette in Wavy e uno in Artemis. Non sono stati rimossi dai log. Il report riporta i codici esatti per asset.

Le registrazioni e le schermate del browser usate per l'ispezione locale rimangono temporanee e non sono incluse nello ZIP. Le immagini presenti sono esportazioni della scena/canvas o documentazione di asset. I report possono citare percorsi temporanei della sessione di prova; gli script permettono di riprodurla.

Nel controllo finale è stata corretta una regola di esclusione troppo ampia: le texture sotto `public/assets/air3/textures/data` sono parte del prodotto e devono essere incluse. Il test di packaging ora verifica esplicitamente questa condizione. La cattura completa e il loopback RTMP sono stati ripetuti dopo l’aggiornamento dell’inventario.

Il packager verifica che il build distribuito corrisponda al test compilato, che le geometrie corrispondano ai report e che tutti i gate richiesti siano verdi. L'archivio esclude `.env`, directory dati, registrazioni, cache, dipendenze scaricate e i vecchi repository. Genera un manifest e checksum dei file e controlla CRC e unicità dei nomi nello ZIP.

## Riproduzione

Dalla radice, dopo il setup:

```bash
npm run qa:logs
npm run qa:live
npm run qa:rtmp
```

Per la sola validazione dei GLB, impostare `AIR3_GLTF_VALIDATOR_MODULE` al modulo `gltf-validator` installato come dipendenza QA separata e `AIR3_QA_DIR` a `docs/validation/live-3.0` con percorso assoluto, quindi eseguire `node tools/validate_runtime_assets.cjs`.

## Riferimenti esterni

- [Restream RTMPS](https://support.restream.io/en/articles/8523770-encrypt-your-stream-with-rtmps)
- [Twitch broadcasting](https://dev.twitch.tv/docs/video-broadcast/)
- [Twitch OAuth](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Twitch EventSub WebSocket](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [Binance Futures Market Streams](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market)
- [CoinGlass Model3 API](https://docs.coinglass.com/reference/liquidation-heatmap-model3)
- [DefiLlama Liquidations](https://defillama.com/liquidations)
- [FFmpeg RTMP](https://ffmpeg.org/ffmpeg-protocols.html#rtmp)
