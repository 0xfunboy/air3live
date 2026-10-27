# AIRTrack sul monitor centrale — adattatore opzionale 3.0

Il modulo Live rimane autonomo. Per mostrare il wallpanel originale AIRTrack, il processo `adapters/dapp-wallpanel.mjs` legge le API pubbliche della dApp già in esecuzione e invia gli snapshot al Live. Non richiede il repository della dApp, Eliza, wallet, iframe o un browser aggiuntivo. Usa Node 24 e i normalizzatori già inclusi in `studio-broadcast/public/pure.mjs`.

## Avvio

1. Avvia il Live con `npm run live`. Nella regia apri **Dati e monitor**, scegli **Wallpanel centrale → Wallpanel esterno · AIRTrack / API** e premi **Aggiorna monitor**.
2. In `studio-broadcast/.env` imposta `AIR3_DAPP_BASE_URL` sull'origine della dApp che espone gli endpoint pubblici. Sono validi sia `https://dapp.example` sia `https://dapp.example/api`; il suffisso `/api` viene aggiunto solo quando manca. Sono ammessi anche prefissi di percorso, per esempio `https://example.com/air3/api`.
3. Usa l'`AIR3_PRODUCER_TOKEN` generato da `npm run init` per questo stesso Live. Non sostituirlo con il token player o con quello operatore. Il file `.env` resta sul server.
4. Da un secondo terminale, nella radice del progetto, esegui:

```sh
npm run bridge:dapp
```

Il comando diretto equivalente, utile anche senza lo script npm, è:

```sh
node --env-file=studio-broadcast/.env adapters/dapp-wallpanel.mjs
```

Per verificare un solo ciclo completo e uscire:

```sh
node --env-file=studio-broadcast/.env adapters/dapp-wallpanel.mjs --once
```

`--once` restituisce codice di uscita 0 solo se lo snapshot è stato accettato dal gateway, altrimenti 1. `--help` funziona senza configurazione e senza connessioni. Ctrl+C o SIGTERM arrestano il polling e interrompono le richieste in corso.

Configurazione minima aggiuntiva alla `.env` del Live:

```dotenv
AIR3_DAPP_BASE_URL=https://dapp.example
AIR3_LIVE_BASE_URL=http://127.0.0.1:5890
AIR3_DAPP_FEED=track
AIR3_DAPP_TIMEFRAME=1h
AIR3_DAPP_ROTATE_SECONDS=12
```

Sostituisci `https://dapp.example` con il tuo endpoint effettivo. Il bridge non ha un servizio pubblico preimpostato. Se Live gira su una macchina diversa, imposta `AIR3_LIVE_BASE_URL` sull'origine raggiungibile; usa HTTPS per trasportare il token fuori dal loopback. Non inserire token o credenziali negli URL. I redirect sono rifiutati: imposta direttamente l'URL definitivo.

## Dati e cadenze

| Operazione | Feed `track`, predefinito | Cadenza predefinita |
|---|---|---|
| Segnali aperti/in attesa | `GET /api/trades?statuses=OPEN,PENDING&limit=50&page=1` | Circa 4 secondi, senza cicli sovrapposti |
| Candele del segnale selezionato | `GET /api/trades/{id}/ohlcv?tf=1h` | Almeno 15 secondi tra aggiornamenti della stessa selezione; subito al cambio segnale |
| Riepilogo | `GET /api/reports?window=all` | 60 secondi |
| Snapshot verso Live | `POST /api/live/wallpanel` | Dopo un ciclo valido |
| Rotazione del segnale | Nessuna chiamata di controllo alla dApp | 12 secondi, con ricaricamento delle candele selezionate |

Il corpo inviato contiene `trades`, `candles`, `report`, `selectedId`, `title`, `source`, `subtitle`, `sourceAt` e `ttlSeconds`. Il gateway usa gli stessi DTO del wallpanel: prezzi di ingresso, take profit, stop loss, P&L e candele del segnale corrente. I prezzi mancanti restano `null`; non viene generata alcuna quotazione. Se non ci sono segnali aperti, la lista e il grafico sono vuoti.

`AIR3_DAPP_FEED=auto` è una scelta esplicita: legge `/api/trades-auto`, `/api/trades-auto/{id}/ohlcv` e `/api/reports-auto`, con etichetta **Auto-trading**. Un errore non provoca il passaggio automatico a un altro feed. Questo mantiene distinta la provenienza dei segnali AIRTrack da quella delle posizioni auto-trading.

`sourceAt` indica il momento di lettura della lista dalla dApp, non l'istante dell'ultima negoziazione in borsa. Il sottotitolo riporta l'età delle letture di candele e riepilogo. La frequenza del bridge non elimina l'eventuale cache del server sorgente: una risposta OHLCV che la dApp conserva per 60 secondi può restare uguale attraverso più polling. Il bridge non modifica quella cache.

## Guasti e scadenza

Ogni richiesta ha un timeout di 4 secondi. Alla prima mancata lettura, risposta malformata o pubblicazione rifiutata, il bridge passa a tentativi distanziati di 4, 8, 16 e poi al massimo 30 secondi. Una lettura riuscita ripristina la cadenza normale. Candele e report vengono riletti alle proprie scadenze; una lettura richiesta che fallisce blocca la pubblicazione dell'intero snapshot.

Lo snapshot precedente scade dopo **30 secondi** dall'ultima pubblicazione riuscita. Il gateway lo segnala come obsoleto; il bridge non ripubblica la vecchia cache per far apparire il pannello aggiornato. Se un segnale selezionato scompare o ruota, vengono lette le candele della nuova selezione prima di pubblicarla: il grafico BTC non viene associato a un'etichetta ETH.

Il limite di ciascuna risposta dApp è 1 MiB; quello del JSON inviato al Live è 128 KiB. Il bridge conserva fino a 50 segnali e 100 candele dopo la normalizzazione. Non scarica immagini, HTML o file multimediali. I log contengono codici controllati, ID del segnale e conteggi; non includono token, corpi di errore del provider o URL con credenziali.

| Codice nel log | Controllo utile |
|---|---|
| `AIR3_DAPP_BASE_URL_REQUIRED` | Imposta l'endpoint pubblico nella `.env`. |
| `AIR3_PRODUCER_TOKEN_REQUIRED` | Esegui l'inizializzazione e usa il token producer del Live; il segnaposto non è una credenziale. |
| `DAPP_TRADES_FAILED` / `DAPP_CANDLES_FAILED` / `DAPP_REPORT_FAILED` | Verifica che il relativo endpoint pubblico risponda in JSON, senza redirect, entro il timeout. |
| `DAPP_TRADES_INVALID` / `DAPP_CANDLES_INVALID` / `DAPP_REPORT_INVALID` | La risposta contiene dati non utilizzabili dal DTO del wallpanel. |
| `LIVE_PUBLISH_FAILED` | Verifica gateway raggiungibile, URL e token producer corrispondenti; consulta il log server per un eventuale rifiuto HTTP. |

Il token producer autorizza la pubblicazione dei contenuti; non abilita la partenza dello streaming né la modifica delle impostazioni. Il bridge non cambia la selezione della sorgente del monitor nella regia. Questa scelta resta esplicitamente all'operatore e persiste nelle impostazioni Live.

## Opzioni facoltative

| Variabile | Valore predefinito | Valori accettati |
|---|---|---|
| `AIR3_LIVE_BASE_URL` | `http://127.0.0.1:${AIR3_PORT}` | Base HTTP(S) assoluta senza credenziali, query o frammento; porta predefinita 5890 |
| `AIR3_DAPP_FEED` | `track` | `track`, `auto` |
| `AIR3_DAPP_TIMEFRAME` | `1h` | `1m`, `5m`, `15m`, `30m`, `1h`, `4h`, `1d` |
| `AIR3_DAPP_POLL_MS` | `4000` | 3000–30000 ms |
| `AIR3_DAPP_CANDLES_MS` | `15000` | 15000–300000 ms |
| `AIR3_DAPP_REPORT_MS` | `60000` | 60000–3600000 ms |
| `AIR3_DAPP_TIMEOUT_MS` | `4000` | 1000–15000 ms per richiesta |
| `AIR3_DAPP_BRIDGE_TTL_SECONDS` | `30` | 15–300 s |
| `AIR3_DAPP_ROTATE_SECONDS` | `12` | 0–300 s; 0 mantiene la selezione finché il segnale esiste |

Il ciclo successivo inizia dopo il ritardo configurato e il completamento del precedente. Tempi di risposta elevati allungano quindi l'intervallo effettivo. Se modifichi le cadenze, mantieni il TTL coerente con il ritardo di polling che desideri tollerare.

## Verifica eseguita

Suite `studio-broadcast/test/dapp-wallpanel.test.mjs`: **11 test superati**. Copre configurazione, equivalenza dei DTO al gateway, null e valori reali, isolamento del token, feed espliciti, cadenze, rotazione, selezione coerente con il grafico, dati malformati e sovradimensionati, backoff, richieste concorrenti, arresto, timeout e redirect HTTP reali su loopback. I test usano risposte controllate e un server locale; non attestano l'accessibilità di una dApp di produzione non configurata in questa sessione.

Esecuzione dalla radice:

```sh
node --test studio-broadcast/test/dapp-wallpanel.test.mjs
```

I risultati sono in `docs/validation/live-3.0/dapp-bridge-tests.txt` e `dapp-bridge-report.json`. Il bridge è facoltativo: interromperlo o non avviarlo non arresta Live, TTS, regia o heatmap.
