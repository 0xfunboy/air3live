# Rilascio e recupero del coordinamento Live V2

Questa è la procedura originaria della fase privata. Il 2 novembre il principale è stato autorizzato e attivato: per lo stato operativo corrente, bridge e recupero usare [Live V2 produzione](LIVE_V2_PRODUCTION.md). Le esclusioni della fase privata sotto non sostituiscono l'autorizzazione successiva dell'operatore.

Le API editoriali sono additive e disabilitate per default. Il servizio pubblico e il suo TTS non vengono sostituiti dal runner privato. Gli endpoint legacy restano disponibili; attivare una sola via vocale per lo stesso programma.

## Contratto producer

Tutti gli endpoint seguenti richiedono il bearer producer, mai token player o operator. Il canale e l'identità del producer sono fissati dalla configurazione server; il corpo non può attribuirsi un altro ruolo.

| Metodo | Path | Funzione |
| --- | --- | --- |
| GET | `/api/producer/v1/capabilities` | Schema, feature, protocollo player e clock server |
| GET | `/api/producer/v1/state` | Capacità, chat pendenti, sequenza più alta e player osservato |
| PUT | `/api/producer/v1/turns/:id` | Reservation `queued` rev1, poi `preparing` rev2 con deadline e sequenza |
| DELETE | `/api/producer/v1/turns/:id` | Cancellazione persistente, anche prima del PUT |
| PUT | `/api/producer/v1/utterances/:id` | Intento `air3.editorial-intent.v1` immutabile con testo, fonte, lingua, scadenza e presentazione |
| GET | `/api/producer/v1/utterances/:id` | Stato e segmenti, tempi audio, sintesi e allineamento |
| DELETE | `/api/producer/v1/utterances/:id` | Cancellazione del parent e dei figli non iniziati; un playing conserva la lease fino allo stop |
| PUT | `/api/producer/v1/news-items/:id` | Titolo revisionato con TTL individuale per ticker |

Limite body 64 KiB, ID sicuri, timeout client breve e redirect vietati. Stesso ID con contenuto diverso dà conflitto; i retry non rinnovano deadline. I tombstone durano almeno 24 ore. I client non devono tentare replay storici dopo la retention.

Il player deve inviare `protocol: "air3.editorial.player.v1"` nei claim. I vecchi bundle sono rifiutati quando il coordinamento è attivo. Ricompilare sempre `studio-broadcast/public/build`, non distribuire soltanto `public/*.mjs`.

## Sintesi prioritaria

Il TTS usa il modello e le voci installati, non un nuovo backend. La rotta aggiuntiva è `POST /v1/editorial/audio/speech`, con bearer dedicato, `X-AIR3-Class`, `X-AIR3-Language` e `X-AIR3-Request-ID`. Il worker reale è unico e limitato; la cancellazione è controllata fra chunk di generazione.

`DELETE /v1/editorial/audio/speech/:requestId` annulla in modo autenticato il lavoro e registra un tombstone anche se il POST arriva dopo. Il gateway usa questa rotta su abort/timeout: non si affida soltanto al disconnect HTTP, che nella prova reale non fermava sempre il generatore ASGI. I retry della voce restano responsabilità dell'outbox producer, non del TTS.

## Configurazione di rilascio

| Componente | Impostazione |
| --- | --- |
| Gateway | `AIR3_EDITORIAL_ENABLED=true` soltanto dopo i gate |
| Gateway | `AIR3_EDITORIAL_PRODUCER_ID=eliza-air3`, `AIR3_EDITORIAL_CHANNEL_ID` uguale al canale reale |
| Gateway | `AIR3_EDITORIAL_ENVIRONMENT=production`; il privato usa `preview` |
| Gateway | `AIR3_TTS_EDITORIAL_TRANSPORT=true`, `AIR3_TTS_BASE_URL` sulla nuova rotta, `AIR3_TTS_API_KEY` nel secret store |
| TTS | `AIR3_TTS_EDITORIAL_ENABLED=true`, `AIR3_TTS_EDITORIAL_TOKEN` uguale alla chiave configurata nel gateway |
| Eliza | Variabili e controlli descritti nel README di `client-twitch-v2` |

Non alterare encoder, destinazioni RTMP, bridge dApp, modelli o voice preset durante questo rilascio. La qualità grafica effettiva proviene da `settings.stream.quality`: un semplice valore env non la sovrascrive. Il privato conserva il preset attualmente funzionante `software`, che sulla macchina osservata usa comunque la RTX 3090. Il profilo HDR `balanced` aveva prodotto immagini nere nel collaudo EGL e non è stato adottato.

## Anteprima privata installata

Worktree `/home/funboy/air3live-v2-dev`. Unità utente `air3-live-v2-preview.service`, gateway `127.0.0.1:5891`, TTS `127.0.0.1:8881`, dati privati sotto `~/.local/state/air3live-v2-preview`. Credenziali generate fuori dal repository, permessi 0600; directory 0700. Il processo nega streaming e non dispone delle credenziali Twitch/RTMP di produzione.

L'unità è attualmente avviata, con recupero su errore, ma non abilitata al boot: dopo un riavvio host va avviata esplicitamente. Questa scelta non modifica l'avvio automatico dei servizi pubblici.

Per visualizzarla dalla propria macchina, aprire un tunnel SSH:

```bash
ssh -p 6666 -L 5891:127.0.0.1:5891 funboy@93.56.125.228
```

Aprire `http://127.0.0.1:5891/studio?output=1`. È un observer: non acquisisce automaticamente la voce. Le registrazioni riproducibili vengono create dai runner privati.

Comandi sul server remoto, senza attivare la live pubblica:

```bash
cd /home/funboy/air3live-v2-dev
/home/funboy/.local/bin/node studio-broadcast/scripts/build.mjs
/home/funboy/.local/bin/node --test --test-concurrency=2 studio-broadcast/test/*.test.mjs
/home/funboy/.local/share/pocket-tts/venv/bin/python3 -m unittest discover -s services/tts-server -p test_priority_tts.py
/home/funboy/.local/bin/node tools/qa-editorial-v2.mjs
/home/funboy/.local/bin/node tools/qa-tts-cancellation-v2.mjs
```

Eseguire i due runner reali in sequenza, non insieme. Il journal QA è persistente: azzerare la sequenza a ogni prova contro lo stesso server causa correttamente un conflitto. Ogni report conserva una copia dello stato; nessun dato privato o token va pubblicato con le prove.

## Ordine del rilascio pubblico

1. Completare gate, canale Twitch di test, ricezione della traccia e osservazione prolungata. Un canary con testo predefinito non misura GemRouter.
2. Conservare una copia coerente di DB, journal, configurazione e build, con componenti drenati. Non distribuire su un DB usato contemporaneamente da un secondo gateway.
3. Pubblicare il codice Live, TTS e bundle compatibili con flag ancora spenti. Verificare il legacy prima di cambiare sink.
4. Caricare il selettore nel bootstrap Eliza durante una finestra concordata; il processo già avviato non lo acquisisce da solo. Poi i cambi riguardano soltanto il client Twitch.
5. Abilitare il coordinamento sul gateway corretto, avviare il player compilato e verificarne le capability. Drenare la V1 con verifica del vecchio audio; attivare V2 tramite il socket privato.
6. Controllare una domanda, relativo ID, prima voce, titolo, ticker, terminali e assenza di doppio audio. Conservare la V1 come recupero esplicito, non automatico.

## Recupero

Se il collaudo privato fallisce, fermare soltanto `air3-live-v2-preview.service`; non fermare `air3-live`, `air3-tts` o Eliza. Le credenziali private e le prove restano recuperabili nella directory di stato.

In produzione fermare nuove ammissioni V2, annullare gli intenti e verificare il drain effettivo prima del percorso inverso. Se il drain non si conclude o il vecchio Gradio è indisponibile, sospendere la voce e mantenere la chat scritta: non avviare due sink. Non cancellare DB o journal per aggirare uno stato incerto.

Le nuove tabelle e colonne SQLite sono additive, ma il ritorno a codice precedente va comunque provato su una copia coerente dopo il drain. Non ripristinare un vecchio binario alla cieca su operazioni ancora attive.
