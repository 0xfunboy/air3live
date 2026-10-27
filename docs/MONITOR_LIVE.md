# Monitor e fonti del modulo #AIR3 Live

Revisione del 27 ottobre 2026. I monitor restano canvas nativi applicati alle superfici 3D. Non caricano iframe della dApp né catturano la pagina web di CoinGlass. dApp ed Eliza sono sorgenti opzionali attraverso un contratto JSON, non dipendenze del servizio.

## Disposizione

| Monitor | Contenuto |
| --- | --- |
| Centrale, incluso il piccolo display della scrivania | Wallpanel: prezzi BTC/ETH/SOL, grafico del simbolo selezionato e riepilogo 24 ore; oppure snapshot AIRTrack/esterno. |
| Destro | Heatmap viola, blu, verde e gialla con candele, scala del valore, finestra temporale e provenienza. |
| Sinistro | Market desk, variazioni 24 ore e testo dell'intervento vocale corrente. |

L'aggiornamento della voce ridisegna soltanto il monitor sinistro. Il client condivide un unico polling di mercato ogni 3 secondi fra i monitor; non ricarica le texture a ogni fonema. Le vecchie modalità AIRTrack/Auto-trading rimangono compatibili con `StudioMonitors.setMarket()`.

## Le tre fonti della heatmap

### Binance: gratuita, liquidazioni osservate

È la fonte reale predefinita. Non richiede credenziali di un conto exchange. Usa le API pubbliche USD-M:

- WebSocket `wss://fstream.binance.com/market/stream`, sottoscrizioni del simbolo selezionato `@forceOrder` e `@kline_5m` (15m/30m per finestre maggiori) più `@ticker` per BTCUSDT, ETHUSDT e SOLUSDT.
- REST `https://fapi.binance.com/fapi/v1/klines` per le candele iniziali.
- REST `https://fapi.binance.com/fapi/v1/ticker/24hr` per il contesto iniziale dei tre simboli.

Il valore delle celle rappresenta **il nozionale eseguito degli ordini completati ricevuti nel campione**, cioè prezzo medio di esecuzione `ap` × quantità eseguita `z`. Un ordine `SELL` corrisponde a una liquidazione long, `BUY` a una liquidazione short. Sono esclusi gli ordini non eseguiti o parziali: il flusso non fornisce un identificatore d'ordine che consenta di ricostruire con certezza tutte le esecuzioni parziali. Quantità richiesta e prezzo limite non vengono usati come sostituti di un'esecuzione mancante.

La documentazione Binance precisa che lo stream trasmette solo l'ultimo ordine per simbolo in una finestra di 1 secondo. **Non è il totale completo delle liquidazioni dell'exchange e non è una mappa di livelli futuri.** Questa distinzione è presente anche sul monitor. Nessuna curva viene inventata per riempire una finestra senza eventi.

La raccolta inizia quando il servizio si connette. Lo storico locale è limitato alle ultime 24 ore e a 100.000 eventi, con scrittura atomica ogni 15 secondi e al termine del servizio. La posizione del file è `data/market-history.json` nella directory dati configurata. Il file non contiene chiavi CoinGlass. In caso di cambio simbolo, le informazioni già raccolte restano associate al simbolo originale. Una finestra di 3 o 7 giorni può mostrare candele più lunghe, ma non ricostruisce liquidazioni precedenti alla raccolta o oltre la conservazione di 24 ore. Il payload espone `collectedSince`, `retainedFrom`, `gaps` e `truncated` per rendere esplicita la copertura.

Il servizio verifica che continuino ad arrivare ticker/candele. Se il socket si blocca per 45 secondi, lo chiude e si riconnette con ritardo esponenziale e jitter fino a circa 30 secondi. L'assenza di liquidazioni, da sola, non è considerata un guasto. I dati eventualmente conservati restano visibili con stato non aggiornato.

La disponibilità delle API Binance dipende dalla rete e dalla regione del server. Il probe reale eseguito in questo ambiente non ha ricevuto dati: `docs/validation/current/live-market/network-probe.json` registra errori di connessione e `realSourceAccessible: false`. L'adattatore è collaudato con risposte e socket controllati; il collegamento al feed va verificato sul server di destinazione. Non viene dichiarata una sessione Binance reale riuscita.

### CoinGlass Model3: integrazione API opzionale

Selezionando `coinglass`, il servizio usa esclusivamente l'endpoint ufficiale:

```text
GET https://open-api-v4.coinglass.com/api/futures/liquidation/heatmap/model3
    ?exchange=Binance&symbol=BTCUSDT&range=24h
Header: CG-API-KEY
```

Il piano e la chiave devono consentire l'accesso a Model3. La documentazione consultata lo indica per **Professional ed Enterprise**, non per i livelli inferiori. Il modulo non acquista un abbonamento e non aggira il controllo di accesso del sito. Il titolare della chiave gestisce le condizioni applicabili al proprio uso dei dati.

I livelli vengono disegnati usando `y_axis`, `liquidation_leverage_data` e `price_candlesticks`. La riduzione alla griglia 144×80 conserva il massimo del livello in ogni cella, evitando di sommare lo stesso livello su diversi istanti e presentarlo come un importo aggiuntivo. I valori indicano stime del modello, non liquidazioni già avvenute.

La chiave rimane nel servizio, non viene inclusa nello snapshot pubblico, nei canvas o nel file storico del mercato. Le richieste rifiutano redirect per non inoltrare la chiave a un'altra destinazione. Mancanza di chiave, piano non abilitato, timeout ed errori sono stati distinti dalla modalità demo. L'API a pagamento non è stata chiamata con una chiave reale durante questo collaudo.

### Demo: scelta esplicita per verificare la grafica

`provider: "demo"` genera una heatmap sintetica con una scritta DEMO visibile e provenienza esplicita. Consente di controllare inquadrature, dimensioni e leggibilità anche senza Internet. Questi dati non sono salvati fra le liquidazioni reali. **Non viene attivata automaticamente quando fallisce Binance o CoinGlass.**

### Perché non usare DefiLlama come sostituto equivalente gratuito

Il dashboard liquidazioni DefiLlama consultato il 27 ottobre 2026 indica che l'accesso richiede una sottoscrizione e riguarda posizioni e livelli di protocolli DeFi. Non è stata individuata e non viene promessa un'API gratuita equivalente alla mappa BTC/USDT Model3 di CoinGlass. La scelta predefinita resta il feed pubblico di liquidazioni effettivamente osservate.

## Contratto del wallpanel centrale

Selezionare `wallpanelSource: "external"` nelle impostazioni del mercato, poi inviare uno snapshot a `POST /api/live/wallpanel` con l'autenticazione di pubblicazione prevista dal gateway. La lettura dei monitor usa `GET /api/live/market` e non restituisce segreti.

Esempio di riepilogo editoriale generico:

```json
{
  "title": "MARKET WALLPANEL",
  "subtitle": "Riepilogo della sessione",
  "source": "Agente #AIR3",
  "ttlSeconds": 300,
  "cards": [
    { "label": "Mercato", "value": "BTC / USDT", "tone": "neutral" },
    { "label": "Sessione", "value": "Europa", "tone": "neutral" }
  ],
  "rows": [
    { "label": "Aggiornamento", "value": "In attesa dei dati", "detail": "Sostituire con informazioni verificate." }
  ]
}
```

Per riutilizzare il contenuto AIRTrack, il payload accetta i DTO già usati dal client della dApp:

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

`trades` può essere un array o `{ "items": [...] }`; vengono accettati gli stati OPEN e PENDING con `id`, `symbol`, `side`, `entry_price`, `tp_price`, `sl_price` e `unrealized_pnl_pct`. `candles` può essere un array o `{ "data": [...] }` con `time`, `open`, `high`, `low`, `close`. Con posizione selezionata e candele, il monitor mostra la scheda entry/TP/SL/PnL, il grafico con livelli e la coda delle posizioni. Il report mantiene la semantica originale e non viene presentato come rendimento di portafoglio o APY.

Il contenuto viene validato, limitato e trattato come testo. Non sono accettati iframe, script o URL da navigare. Il TTL varia da 15 secondi a 24 ore; superata la scadenza il pannello viene marcato come non aggiornato. Lo snapshot persistito mantiene la scadenza e non diventa automaticamente fresco al riavvio.

Un adattatore AIRTrack precedente già configurato può continuare ad alimentare il canvas attraverso `setMarket()`. In modalità esterna, in assenza di uno snapshot push, il renderer può usare quel flusso. Non viene importata l'intera dApp e il wallpanel non richiede login wallet.

## Interfacce interne

```js
const market = createLiveMarketService({ dataDir, config: settings.market });
await market.start();
await market.configure(nextSettings.market);
const snapshot = market.snapshot();
await market.setWallpanel(payload);
await market.stop();
```

Campi di configurazione: `enabled`, `provider`, `symbol`, `range`, `wallpanelSource`, `coinglassKey`. `enabled: false` non apre socket né richieste HTTP. `publicConfig()` sostituisce la chiave con il solo indicatore `coinglassConfigured`.

```js
const client = createLiveMarketClient({
  onUpdate: snapshot => monitors.setLiveMarketSnapshot(snapshot)
});
client.start();
// Al termine della pagina:
client.stop();
```

Il modulo client accetta soltanto un percorso API della stessa origine, limita la risposta a 3 MiB, interrompe le richieste allo smontaggio e ignora risposte tardive. Le fonti cambiate non possono rietichettare come ETH candele rimaste da BTC.

## Verifica eseguita

- `node --test test/live-market.test.mjs`: 19 test su mapping, valori mancanti, provenienza, errori, riconnessione, heartbeat, persistenza, cambio provider, arresto durante il caricamento, configurazione sequenziale e teardown del client.
- `node scripts/qa-live-market.mjs`: 15 esportazioni canvas in Chromium headless, zero errori JavaScript. Gli input di collaudo sono esplicitamente marcati; non sono catture di mercato reale.
- `node scripts/probe-live-market.mjs`: probe pubblico senza chiavi, 12 secondi. Il risultato reale dell'ambiente è registrato, inclusi gli errori di rete.

Queste verifiche non sostituiscono un test prolungato sul server di streaming né un controllo della disponibilità dei dati dal suo indirizzo di rete.

## Fonti ufficiali consultate

- [Binance USD-M WebSocket, sezione Market](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/ws-streams/market): percorso `/market/stream`, schema forceOrder e campionamento di 1 secondo.
- [Binance USD-M REST, Market Data](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data): candele e ticker 24 ore.
- [CoinGlass Pair Liquidation Heatmap Model3](https://docs.coinglass.com/reference/liquidation-heatmap-model3): API ufficiale, schema e piani abilitati.
- [DefiLlama Liquidations](https://defillama.com/liquidations): ambito delle posizioni DeFi e accesso con sottoscrizione.

