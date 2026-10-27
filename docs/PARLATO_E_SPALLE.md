# #AIR3: spalle naturali durante il parlato

La correzione riguarda i quattro clip `MH_Talk`, `MH_Talk01`, `MH_Talk02` e `MH_Talk03`. Il riferimento resta la posa iniziale `MH_Idle01_UE` del modello consegnato; mesh, bind pose, lunghezze ossee e animazioni sorgenti non sono state riscalate o sovrascritte.

## Intervento

Il nuovo modulo `studio-broadcast/public/air3-talk-shoulders.mjs` misura l'altezza dell'attacco del braccio rispetto al collo nello spazio locale dell'avatar. La rotazione della clavicola mantiene quella distanza entro una variazione morbida di 8 mm rispetto al riferimento, quando il parlato raggiunge peso pieno. La funzione continua `tanh` evita un arresto rigido al limite.

La contro-rotazione dell'omero conserva l'orientamento originale del gesto di braccio, gomito e mano. La spalla viene riportata all'altezza naturale senza stirare il collo o le ossa e senza bloccare gli arti. La piccola traslazione complessiva delle mani che segue il nuovo attacco della spalla è intenzionale; non si dichiara che le mani restino nello stesso punto assoluto.

La correzione segue i pesi normalizzati delle animazioni durante le dissolvenze e viene ripristinata prima di ogni valutazione del mixer, anche quando si cerca ripetutamente lo stesso fotogramma. L'ordine è mixer, correzione del parlato, strato di movimento nello studio, sguardo/viso. Lo strato della camminata conserva la propria calibrazione già verificata. A peso talk nullo i clip idle e mocap non vengono corretti.

## Riscontri sul modello reale

La prova numerica confronta la revisione corretta e lo stesso modello con la sola correzione disabilitata. Sono stati campionati tutti i quattro clip a 60 Hz, per 3.731 fotogrammi. Le misure indicano la discesa dell'attacco dell'omero rispetto al collo, non l'abbassamento dell'intero corpo.

| Clip | Caduta massima prima | Caduta massima corretta |
| --- | ---: | ---: |
| MH_Talk | 11,725 mm | 7,190 mm |
| MH_Talk01 | 43,148 mm | 8,000 mm |
| MH_Talk02 | 28,418 mm | 7,987 mm |
| MH_Talk03 | 32,767 mm | 7,996 mm |

Nello stesso confronto, differenze delle traslazioni ossee, delle scale e delle posizioni della parte inferiore del corpo: zero. L'errore massimo misurato nell'orientamento del braccio/gomito/polso è inferiore a `9e-8` radianti, compatibile con l'aritmetica numerica.

I quattro nuovi test verificano i clip completi, le dissolvenze rapide, l'assenza di accumulo durante pause e seek e l'invarianza su un avatar traslato, ruotato e scalato uniformemente. Sono stati eseguiti insieme alle regressioni di animazione, sguardo e camminata: 20 test superati, nessun fallimento. I nuovi test sono quattro, non venti aggiuntivi.

## Verifica visiva e riproduzione

Il collaudo sorgente in Chromium/SwiftShader produce 16 immagini: quattro clip, due viste e due varianti, originale/corretta. Ogni coppia usa la stessa maglietta aggiornata, la stessa capigliatura e lo stesso istante del clip. Nessun errore JavaScript, HTTP o shader rilevato. La luce diffusa diagnostica consente di valutare il profilo; non coincide con i cinque riflettori dello studio.

Evidenze: `docs/validation/current/talk-shoulders-report.json`, `docs/validation/current/talk-shoulders/visual-report.json`, immagini e `docs/validation/current/talk-shoulders/tests.txt`. I report contengono gli hash dei sorgenti e degli asset misurati.

Dal percorso `studio-broadcast`:

```bash
node --test test/talk-shoulders.test.mjs
node scripts/qa-talk-shoulders.mjs
node scripts/qa-talk-visual.mjs
```

L'ultima prova richiede il browser installato dal progetto oppure `AIR3_CHROME_PATH`. Non misura FPS in tempo reale su GPU. L'inviluppo degli 8 mm descrive il parlato a peso pieno prima dello strato di movimento/puntamento; non è un vincolo rigido su ogni posa possibile, né una simulazione dei tessuti o dei muscoli.
