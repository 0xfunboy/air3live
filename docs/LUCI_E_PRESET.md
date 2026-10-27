# Luci e aspetto: regia interattiva

Questa revisione sostituisce l’illuminazione frontale estesa con **cinque faretti conici indipendenti**. Il preset iniziale riproduce esattamente il file luminoso fornito dall’utente: ambiente diffuso 0, IBL 0,17, esposizione 0,95; conserva i cinque faretti, le potenze, le posizioni, i colori e le ombre selezionate. L’avatar mantiene geometria, proporzioni, rig e texture della pelle già presenti: il confronto serve a scegliere la luce, non a modificare il viso.

## Dove sono i controlli

Avvia `npm run preview` dalla radice del progetto, dopo `npm ci --prefix studio-broadcast`.

- **Personaggio:** `http://127.0.0.1:5892/`. Il pannello «Luci e aspetto» è nella colonna destra. Le viste Volto e Scarpe aiutano a valutare i dettagli; trascina la scena per cambiare angolazione.
- **Studio:** `http://127.0.0.1:5892/studio`. Il pulsante «Luci e aspetto» apre la regia sovrapposta. Il riquadro si può chiudere con ✕ o Esc.
- **Uscita pulita:** il collegamento «open clean program view» nasconde tutti i controlli. Le guide dei coni non vengono visualizzate in questa uscita.

Le schede **Luci** e **Aspetto** separano i controlli. Il selettore del faretto sceglie quale dei cinque modificare: gli altri mantengono i propri parametri. I campi numerici accanto ai cursori permettono valori precisi.

## Parametri delle luci

| Parametro | Effetto |
|---|---|
| Luce diffusa | Intensità della luce emisferica: attenua o apre le ombre senza aggiungere un faretto frontale. |
| Ambiente e riflessi | Intensità della mappa HDR/IBL. Influisce sulla luce indiretta e sulla risposta dei materiali. Non è una luce ambientale separata solo per gli speculari. |
| Esposizione | Esposizione del tone mapping dell’intera scena, compreso il set. |
| Potenza del faretto | Intensità della `SpotLight`, in candele, con attenuazione quadratica della distanza. |
| Posizione sul cerchio | Azimut rispetto al centro della postazione: 0° davanti, +90° a destra della scena, −90° a sinistra, ±180° dietro. |
| Distanza dal centro | Raggio, in metri, del posizionamento del singolo faretto. |
| Altezza faretto | Quota in metri rispetto al piano della postazione. |
| Altezza di puntamento | Quota del bersaglio verso cui è orientato il cono. |
| Semiapertura del cono | Angolo fra asse del faretto e bordo esterno. L’apertura completa è il doppio. |
| Morbidezza del bordo | Penombra del bordo del cono, da 0 a 1. Non è una simulazione della dimensione fisica dell’emettitore. |
| Colore | Colore sRGB del faretto. |
| Ombre | Abilita il calcolo delle ombre per quel faretto, entro il profilo di qualità scelto. |
| Punta alla presentatrice | I fari restano nella loro posizione e orientano il bersaglio verso la presentatrice mentre si sposta. Disattivalo per conservare la mira sulla postazione principale. |

I preset iniziali collocano una key frontale a destra e più in alto, un laterale destro, un fill frontale sinistro debole e due controluce. I cinque fari sono veri `SpotLight`: le guide mostrano i loro coni, senza aggiungere nebbia o fasci volumetrici alla trasmissione.

**Qualità:** High e Balanced rispettano gli interruttori delle ombre di tutti i fari. Software usa soltanto la mappa delle ombre della key; tutti e cinque continuano a illuminare. Accendere cinque mappe delle ombre costa più di accendere cinque luci senza ombre. Il valore FPS mostrato nell’interfaccia è quello realmente renderizzato dall’host.

## Salvataggio, confronto e condivisione

Le modifiche si salvano automaticamente nel browser, per la stessa origine web. Anteprima, studio e uscita pulita nello stesso browser ricevono il preset tramite l’evento `storage`. Non vengono salvati token, audio o dati di mercato nel preset.

1. Scegli il nome nella sezione «Il tuo preset».
2. Premi **Esporta JSON**: il file si chiama `airewardrop-look.json`.
3. Per confrontare una configurazione precedente, usa **Importa JSON**.
4. **Ripristina** applica il preset incluso nel pacchetto e lo salva come preferenza locale.
5. Per comunicare i valori scelti, allega il JSON. Contiene tutte le luci, acconciatura, colore, maglietta, scarpe e variante del gambale, con i valori numerici esatti.

I file importati vengono controllati integralmente: schema, cinque identità dei fari, intervalli numerici, scelte ammesse. Un preset non può caricare un URL arbitrario o alterare lo scheletro. I file oltre 32 KB sono rifiutati.

### Fissare il look nel pacchetto / nel broadcaster

Il browser headless del broadcaster può avere un profilo separato: **le preferenze salvate nel browser dell’operatore non modificano automaticamente quel processo**. Per fissare il risultato, sostituisci il contenuto di:

`studio-broadcast/public/assets/air3/presets/default-look.json`

con il JSON esportato, mantenendo il nome del file di destinazione. Riavvia l’anteprima o il broadcaster. Il file viene letto senza cache all’avvio; la modifica non richiede ricompilare il JavaScript. Nel browser dell’operatore, premi Ripristina dopo il riavvio per eliminare l’effetto delle vecchie preferenze locali. Per un confronto isolato puoi aprire la pagina con `?resetLook=1` (nel set, `/studio?resetLook=1`).

Lo ZIP distribuito include un preset funzionante. L’eventuale scelta di asset marcati «non commerciale» deve restare coerente con le licenze degli asset; il pannello indica questi casi e il dossier delle risorse conserva le attribuzioni.

## API esposta per le verifiche

Sia `window.assetPreview` sia `window.air3Studio` espongono:

```js
await air3Studio.ready;
const preset = air3Studio.getLookPreset();
preset.lighting.lights[0].intensity = 24;
await air3Studio.setLookPreset(preset);
await air3Studio.setHair('wavy', 'espresso');
await air3Studio.setFootwear('boot', 'relaxed');
await air3Studio.setClothing('crop');
```

`setLighting()` applica solo l’oggetto `lighting`; `getLookPreset()` legge i valori effettivamente applicati. Le selezioni sono asincrone quando occorre caricare un modello o un atlante. Durante il caricamento il pannello mantiene visibile lo stato e blocca le proprie regolazioni per evitare modifiche sovrapposte.

## Aspetto e compatibilità v2

Il default è Wavy Espresso (`#3b2b21`), maglietta originale e stivaletti con gambale adattato. Il menu **Maglietta** offre il top corto bianco fornito; il menu **Gambale** compare quando gli stivaletti sono selezionati. La variante bassa conserva piedi, tacco e ossa; cambia la geometria del bordo. Il colore delle sopracciglia segue quello dei capelli.

Lo schema esportato è `airewardrop.look.v2`. Aggiunge `clothing.style` (`original`/`crop`) e `footwear.fit` (`relaxed`/`low-cut`). L’importazione di v1 conserva tutte le luci e i colori, e aggiunge maglietta originale e gambale adattato. I vecchi salvataggi v1 del browser non vengono applicati automaticamente alla 2.3: questa scelta permette di aprire la nuova versione con il look richiesto. Un JSON v1 si può ancora caricare con Importa.

L’espressione è un controllo distinto dal preset luci/aspetto: inizialmente è «Leggermente felice» al 100%. Il testo semplice mantiene questa scelta anche durante il parlato. Un’emozione esplicita di una narrazione viene applicata durante il parlato; al termine e dopo una cancellazione viene ripristinata la scelta della regia. Il preset non incorpora né altera i messaggi dell’agente.
