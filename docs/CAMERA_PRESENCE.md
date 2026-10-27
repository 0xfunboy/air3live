# Sguardo, presenza e transizioni della conduttrice

La revisione aggiunge un bersaglio dello sguardo in coordinate reali dello studio. La camera attiva rimane il riferimento anche durante i cambi di inquadratura; un gesto verso un monitor può sostituirlo temporaneamente. Collo e testa seguono con un movimento limitato, mentre gli occhi compensano il movimento residuo della testa.

## Implementazione e calibrazione

`public/air3-attention.mjs` legge gli assi dalla bind pose del personaggio effettivo: nel nodo `FACIAL_C_FacialRoot`, +Y è in avanti, +X è il lato sinistro anatomico e −Z è verso l'alto. Le ossa corporee hanno un orientamento locale diverso. Il controller converte gli assi del volto nello spazio della testa e applica le correzioni nello spazio dei rispettivi genitori, senza assumere che l'asse Y locale di ogni osso sia verticale.

L'ordine del rig è:

1. Ripristino degli offset additivi del frame precedente.
2. Valutazione e fusione delle animazioni corporee.
3. Eventuale livello procedurale per camminata o gesto.
4. Correzione di collo e testa verso il bersaglio.
5. Sincronizzazione delle gerarchie corpo, abito e volto.
6. Soluzione binoculare, espressioni e labiale.
7. Contatto a terra e aggiornamento degli accessori.

I limiti delle **correzioni additive** sono ±48° in orizzontale e −18°/+20° in verticale per l'insieme collo/testa. Le quote sono 14% su `neck_01`, 19% su `neck_02` e 67% sulla testa. Ogni occhio ha un limite di ±24° in orizzontale e ±17° in verticale. Un bersaglio alle spalle non produce una rotazione completa del collo: per seguirlo occorre girare il corpo.

Il bersaglio nello spazio è smorzato con costante di tempo 110 ms, collo/testa con 300 ms e compensazione oculare con 25 ms. La risposta oculare più rapida evita che una naturale oscillazione della testa nella clip parlata trascini lo sguardo lontano dalla camera.

Durante il parlato una breve deviazione dello sguardo può verificarsi ogni 14 secondi, per circa 550 ms; durante le pause il periodo è 10,8 secondi e la durata circa 850 ms. Sono deviazioni lievi, fino a 2,8°, con entrata e uscita morbide. Un bersaglio esplicito disabilita queste deviazioni. Non si tratta di una routine Unreal importata: è una ricostruzione procedurale sul rig web disponibile.

## API per la regia

```js
// Assegnare la camera reale: il rig rilegge la posizione mondiale ogni frame.
rig.setCameraTarget(camera);

// Indicare il punto del monitor guardato durante un gesto.
rig.setAttentionTarget(monitorWorldPosition, { kind: 'monitor', weight: 1 });

// Tornare progressivamente al pubblico.
rig.clearAttentionTarget();

// Ispezione del profilo senza compensazione verso l'osservatore.
rig.setEyeContactEnabled(false);

// Livello corporeo procedurale. Gli offset vengono ripristinati al frame dopo.
rig.setBodyPoseLayer((dt, rig) => { /* IK o posa additiva sulle bodyBones */ });
rig.setBodyPoseLayer(null);
```

`setCameraTarget` accetta un `Object3D`, un `Vector3` o una terna numerica. Un oggetto camera viene seguito direttamente; un vettore viene copiato, quindi un vettore aggiornato deve essere passato nuovamente. `setAttentionTarget` rifiuta coordinate non finite. Il peso interpola il punto della camera e quello del bersaglio. `diagnostics().attention` espone stato, limiti e angoli effettivi.

## Espressioni lievi

Sono conservati `neutral`, `warm`, `happy`, `sad`, `focused`, `concerned`, `surprised` e gli alias italiani dell'archivio ricevuto. L'intensità interna del rig in assenza di parametri è 0,35; dalla revisione 2.3 le due interfacce applicano invece esplicitamente Leggermente felice al 100% all’avvio; l'intensità richiesta resta regolabile da 0 a 1. Il cambiamento di emozione è interpolato, senza ripartire da zero quando il player ripete lo stesso stato.

In `neutral`, `warm` e `happy` è presente una variazione molto leggera del sorriso. L'ampiezza procedurale va da 0,055 a 0,155 prima dei coefficienti ossei, e si riduce durante il parlato. Sorpresa, tristezza e preoccupazione richiedono uno stato esplicito: il renderer non interpreta prezzi e notizie per dedurre sentimenti. La componente emotiva della bocca rimane attenuata durante l'articolazione vocale.

Per un confronto neutro o un'ispezione delle pose è possibile usare `rig.setMicroExpressionsEnabled(false)`. Le pose diagnostiche manuali conservano il campionamento esatto e non vengono animate come se fossero parlato in tempo reale.

## Labiale e transizioni corporee

L'archivio ricevuto conteneva già damping dei visemi e fade tra le clip. Questa revisione rende continua la forma **prima** del damping e stabilizza i cambi rapidi tra animazioni.

`mouthPoseWeightsAt(cues, elapsed, duration)` campiona le vere annotazioni Rhubarb sul clock audio. Un kernel continuo di 90 ms, con anticipo di 14 ms, distribuisce il peso tra forme adiacenti. I vuoti della timeline restano la forma chiusa `X`; non vengono creati nuovi fonemi o tempi dal testo. I pesi sono normalizzati e il costo di ricerca è logaritmico più le poche forme attraversate dal kernel. Il player completo e le demo possono passare `mouthWeights` insieme al codice `mouthCue`, che rimane disponibile per l'HUD.

Il volto miscela i parametri delle nove forme prima di applicare la modulazione dell'ampiezza del WAV. La posa pesata usa damping con coefficiente 36/s; i vecchi chiamanti che inviano solo `mouthCue` continuano a funzionare con coefficiente 22/s.

Il corpo usa un insieme di pesi normalizzati con costante di tempo 180 ms. Un nuovo cambio di stato modifica i pesi correnti senza creare una seconda curva di fade indipendente e senza riavviare una clip ancora in esecuzione. Le azioni ormai prive di peso vengono fermate. La geometria, il retarget delle traslazioni e il supporto fino a dodici influenze rimangono invariati.

## Verifiche riproducibili

```bash
cd studio-broadcast
node --test test/avatar-attention.test.mjs test/avatar-rig.test.mjs test/lip-sync.test.mjs
node scripts/qa-attention.mjs
```

Il [report numerico](validation/history/lookdev-2.3.0/camera-attention-report.json) verifica le sette clip fornite con tre posizioni della camera, su uno studio traslato, ruotato e scalato: 21 combinazioni e 5.040 misure dei due occhi dopo l'assestamento. Nel report generato per questa revisione l'errore angolare massimo è **2,63°**. La misura confronta l'asse anteriore delle ossa oculari con la direzione del bersaglio; non è un punteggio di somiglianza fotografica o una verifica dei riflessi dell'iride.

I test comprendono anche il cambio istantaneo di camera con risposta smorzata, la priorità del monitor e il ritorno alla camera, limiti per bersagli irraggiungibili, assenza di accumulo nel livello procedurale e normalizzazione dei pesi durante ripetuti cambi idle/parlato. I test della geometria e dello skinning originali restano presenti.

## Limiti

Questa soluzione non ricostruisce MetaHuman RigLogic completo e non aggiunge la cattura facciale originale Unreal. Gli occhi seguono un bersaglio tridimensionale; l'intenzione narrativa di un gesto va fornita dalla regia. Il labiale rimane una soluzione a nove forme, con i tempi dell'allineatore e i limiti delle articolazioni disponibili. La continuità matematica non compensa una cadenza di rendering insufficiente: fluidità e latenza del live vanno verificate sull'hardware di esecuzione.
