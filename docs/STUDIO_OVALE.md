# Studio ovale e disposizione scenica

Revisione del 24 ottobre 2026. La scena è definita in `studio-broadcast/public/studio-scene.mjs`; il sistema di riflessi e composizione resta in `studio-rendering.mjs`.

## Modifiche realizzate

Il fondale rettilineo è stato sostituito da un arco ellittico continuo, largo circa 12,3 metri e profondo 4,65 metri nella metà posteriore. Parete, lamelle acustiche istanziate, fasce luminose e fascia superiore seguono lo stesso arco. Tre inserti ovali nel pavimento danno riferimenti di profondità senza creare gradini sul percorso della conduttrice.

I monitor principali sono oggetti indipendenti, staccati dal fondale. Ognuno comprende chassis con spessore, montante, traversa posteriore, canale per i cavi e base a pavimento. I laterali sono ruotati di circa 28,6 gradi verso il centro dello studio. La distanza fra lo schermo centrale e la parete di fondo è circa 1,2 metri; i laterali conservano uno spazio visibile tra lo schermo e la parete curva. Le superfici dei grafici restano prive di vetro sovrapposto per mantenere il testo leggibile nel video compresso.

Il desk è stato ridotto a 2,70 metri di larghezza e spostato verso destra e verso il pubblico. Il lato centrale e la zona dietro il desk restano liberi per raggiungere le tre postazioni di presentazione. Il top ha clearcoat, il fronte è in vetro e la struttura usa metallo fisico. Il simbolo aziendale fornito è caricato dal file locale `assets/air3/branding/airewardrop-mark.png`, senza ridisegnarlo. Le insegne del set usano il nome `airewardrop` e non la dicitura con hashtag.

## Coordinate e contratto del movimento

Le coordinate sono espresse in metri nel sistema dello studio: +Y verso l'alto, +Z verso il pubblico. `STAGE_LAYOUT` è esportato dal modulo della scena e assegnato a `scene.stageLayout`.

| Elemento | X | Y | Z |
|---|---:|---:|---:|
| Postazione iniziale | -0,75 | 0,005 | 0,65 |
| Centro del monitor sinistro | -3,55 | 1,95 | -2,30 |
| Centro del monitor centrale | 0 | 2,15 | -3,55 |
| Centro del monitor destro | 3,55 | 1,95 | -2,30 |
| Postazione di spiegazione sinistra | -2,50 | 0,005 | -0,85 |
| Postazione di spiegazione centrale | -0,80 | 0,005 | -1,85 |
| Postazione di spiegazione destra | 2,45 | 0,005 | -0,85 |
| Centro del desk | 1,65 | 0 | 1,20 |

`routes.left`, `routes.center` e `routes.right` contengono percorsi dalla postazione iniziale al punto di spiegazione. I punti intermedi evitano il volume del desk. Il controller del movimento consuma questi dati; non deve attraversare direttamente il desk quando cambia destinazione.

Le postazioni restano a una distanza che consente di indicare il grafico senza toccare lo schermo. Il gesto è una presentazione direzionale. Non si dichiara una simulazione di contatto della mano con il pannello.

La scena espone:

- `getMonitorTarget(id)`: punto sul piano del monitor in coordinate mondo, per `left`, `center`, `right`.
- `presentMonitor(id)`: inoltra la richiesta al controller del movimento.
- `returnHome()`: richiede il ritorno alla postazione iniziale.
- `enableRoaming(enabled)`: attiva o disattiva la modalità automatica del controller.

Durante ogni frame il controller aggiorna la posizione prima della regia. La camera `presenter` segue la posizione della conduttrice. La camera reale viene passata al rig con `setCameraTarget(camera)`, così lo sguardo può seguirne lo spostamento e la transizione tra le inquadrature. Il controller può dare temporaneamente priorità al monitor mentre la conduttrice lo presenta.

## Rendering e prestazioni

Sono conservati i tre profili `software`, `balanced` e `high`, l'ambiente HDR di softbox generato localmente, la pipeline lineare con ACES/sRGB e il riflesso planare del pavimento. `high` mantiene GTAO, bloom e ombre a risoluzione più alta; `balanced` usa il riflesso ridotto senza GTAO. La scena amplia la regione della luce con ombre per coprire i percorsi verso i monitor.

Le lamelle acustiche usano una singola `InstancedMesh`. Le pareti curve sono tre superfici a basso numero di segmenti. La modifica aggiunge volume scenografico mantenendo il medesimo percorso di acquisizione e trasmissione video.

I benchmark Intel/NVIDIA contenuti nell'archivio in ingresso si riferiscono alla revisione precedente. Non devono essere presentati come misure di questa nuova scena. Le verifiche della versione consegnata sono registrate in `docs/validation/current`; l'assenza di errori WebGL non sostituisce un benchmark sulla GPU di destinazione.
