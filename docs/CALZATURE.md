# Calzature intercambiabili

La demo offre tre scelte nel menu del look. Gli **stivaletti Aquateknica** sono la sostituzione consigliata: conservano la texture fotografica della pelle, hanno una forma leggibile anche nelle inquadrature larghe e una licenza che permette l'uso commerciale con attribuzione. Le sneakers del progetto restano disponibili. I tacchi aperti sono una variante dimostrativa contrassegnata **non commerciale** nel menu.

| Scelta | Origine | Licenza dichiarata dall'asset | Geometria disegnata per la coppia |
| --- | --- | --- | ---: |
| Sneakers originali | Asset già presente nel progetto | Condizioni degli asset del progetto | Geometria originale |
| Stivaletti in pelle | Boot, Aquateknica | CC BY 4.0 | 40.746 triangoli |
| Tacchi aperti | Shoes test, Bente Aimee | CC BY-NC 4.0 | 30.644 triangoli |

Il fatto che un modello sia allegato alla conversazione non cambia la sua licenza. Il modello `shoes_test.glb` contiene esplicitamente CC BY-NC 4.0 nei metadati. È incluso nella demo con quella limitazione; per un impiego commerciale di questa variante occorre una licenza dell'autrice che lo consenta. Questa limitazione non riguarda gli stivaletti Aquateknica.

## Preparazione dei modelli

`boot.glb` è una scansione di un solo stivaletto, suddivisa in quattro parti ai limiti degli indici a 16 bit: **370.422 triangoli e 13.914.952 byte**. Il convertitore riunisce i duplicati di posizione/UV/normale, conserva le discontinuità delle UV e applica la semplificazione con attributi di meshoptimizer 0.24.0. Il modello finale ha **20.373 triangoli e 3.206.212 byte**, compresa la texture originale 2048×2048. Il secondo piede usa la stessa geometria specchiata con ordine dei triangoli corretto. Il materiale specular/glossiness del file ricevuto è convertito in un materiale PBR compatibile con il renderer corrente. I riflessi già fotografati nella texture rimangono parte del colore: non sono una mappa di riflettanza separata.

`shoes_test.glb` include due scarpe, i lacci e due piedi/manichini di prova. Il convertitore conserva una sola scarpa e la porzione di dati necessaria a generare la coppia. Il GLB ottimizzato pesa **1.117.592 byte**, con **24.700 triangoli** prima del ritaglio della geometria interna effettuato dal controller. Per evitare le compenetrazioni presenti fra il piede di prova e la scarpa, viene disegnata solo la piccola porzione delle dita visibile nell'apertura anteriore; il collo del piede e il moncone del manichino sono esclusi. Il colore di questa porzione è un'approssimazione dell'incarnato, non la texture MetaHuman.

Il modello aperto è adattato alla taglia della presentatrice nelle coordinate dell'accessorio: larghezza e altezza, più un raccordo del gambale e dei lacci verso lo stinco verticale. La suola mantiene una lunghezza nominale di 25 cm. Questa variante non pretende di riprodurre immutata la calzata del manichino originale. Per ottenere una calzata sartoriale serve un lavoro dedicato sulla forma interna e una posa specifica per il tacco.

I due originali sono conservati senza modifiche in `source-assets/footwear/`. Hash e provenienza sono riportati in `source-assets/footwear/SOURCES.json`. La revisione del 25 ottobre aggiunge il top corto fornito dall'utente e due calzate degli stivaletti, descritte in [Top corto e calzata degli stivaletti](TOP_E_STIVALETTI.md).

## Collegamento all'avatar

Il controller usa le matrici inverse della posa di legatura del MetaHuman, quindi può essere creato anche dopo che il rig è già animato e il suo contenitore è stato scalato uniformemente per la presentazione. Le scarpe sono pesate sulle ossa esistenti `foot`, `calf` e `ball` dei due lati; non viene introdotto uno scheletro parallelo e non vengono cambiate lunghezze o scale delle ossa del corpo.

Le sneakers vengono nascoste solo dopo il caricamento riuscito della nuova scelta. I triangoli del piede coperti dalla calzatura, sotto 9 cm nello spazio originale del modello, sono esclusi con un indice di disegno reversibile. Le posizioni, le UV, i pesi e il file GLB originali restano invariati. Tornando alle sneakers viene ripristinata esattamente la geometria originale. Le scarpe nuove condividono la stessa altezza nominale della suola delle sneakers; non viene allungato il corpo per sostenere il tacco.

La modifica corregge anche una classificazione storica dei materiali: `outfit__material_0` è la coppia di sneakers, mentre `outfit__lambert2SG` è la gonna scozzese. In precedenza i due materiali ricevevano le impostazioni di superficie invertite.

## API

```js
const footwear = await createFootwearController({ avatarRoot: gltf.scene, rig });
await footwear.setStyle('boot', { fit: 'relaxed' }); // original | boot | shoes-test
await footwear.setFit('low-cut'); // relaxed | low-cut; valido per gli stivaletti
footwear.update();              // dopo l'aggiornamento del rig
footwear.getState();
footwear.diagnostics();
footwear.dispose();             // ripristina le mesh originali
```

I caricamenti vengono riutilizzati; un cambio rapido di menu applica l'ultima selezione. Un errore di caricamento conserva la scelta visibile precedente. `dispose()` ripristina il corpo e le sneakers e libera le risorse degli accessori, anche quando un caricamento termina dopo la chiusura.

## Verifica

`studio-broadcast/scripts/qa-footwear.mjs` carica i moduli reali in Chromium e rende nove immagini WebGL: tre viste per ciascuna scelta. Verifica inoltre il rifiuto delle scelte sconosciute, la precedenza dell'ultima selezione e il ripristino delle sneakers. Il report della precedente revisione 2.2 e le immagini sono conservati in `docs/validation/history/lookdev-2.2.0/footwear/`. La 2.3 verifica nuovamente tutte le scelte nella matrice compilata e i nuovi gambali in `docs/validation/current/wardrobe-refinement/`.

`studio-broadcast/test/footwear.test.mjs` controlla contenitori GLB, indici, coordinate finite, dimensioni ragionevoli, budget geometrico, materiale PBR e licenze. Controlla inoltre gli hash degli originali. La verifica indipendente delle scarpe usa SwiftShader: è un collaudo funzionale e visivo, non un benchmark GPU. La camminata e il look complessivo sono verificati anche nel collaudo dell'app compilata. Non è stata aggiunta una camminata specifica per tacchi alti.

## Riproduzione della conversione

Il convertitore è `tools/prepare_footwear.mjs`. Richiede le dipendenze del
servizio e `meshoptimizer@0.24.0`, usato soltanto per la conversione. Dalla radice
del progetto, gli stessi comandi valgono su Windows, Linux e macOS:

```sh
npm ci --prefix studio-broadcast
npm install --prefix tools/converter-deps --no-save --no-package-lock --ignore-scripts meshoptimizer@0.24.0
node tools/prepare_footwear.mjs source-assets/footwear
```

Il modulo viene trovato automaticamente nell'installazione separata
`tools/converter-deps`. `--meshopt <file-del-modulo>` o `AIR3_MESHOPT_MODULE`
permettono un'installazione alternativa; i percorsi Windows vengono convertiti
in URL di file prima dell'import. `--output build/footwear-rebuilt` consente di
rigenerare in un'altra directory, senza sostituire gli asset runtime.

Il manifest dei risultati viene scritto accanto ai GLB ottimizzati. Per
l'ambiente completo e le versioni effettivamente utilizzate vedere
[Strumenti di ricostruzione](../tools/README.md). L'audit finale ha verificato
che la conversione da una directory esterna riproduce entrambi i GLB identici
byte per byte; il test è stato eseguito su Linux.
