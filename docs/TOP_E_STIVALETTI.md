# Top corto e calzata degli stivaletti

Revisione del 25 ottobre 2026. Il menu mantiene **Maglietta originale** come
impostazione iniziale e aggiunge **Top corto bianco · DaaGHrii** per il confronto.
Gli stivaletti usano inizialmente **Gambale adattato**; **Gambale basso** offre
una seconda soluzione selezionabile. Queste modifiche riguardano gli accessori:
le proporzioni, le lunghezze delle ossa e le posizioni dei vertici del corpo non
vengono modificate.

## Top fornito dall'utente

Il file originale, non riggato, è conservato senza modifiche in
`source-assets/clothing/off_shoulder_top.glb`. Provenienza, licenza dichiarata
dall'asset e hash sono in `source-assets/clothing/SOURCES.json`.

**Attribuzione:** “Off Shoulder Top”, di [DaaGHrii](https://sketchfab.com/DaaGHrii),
[modello originale](https://sketchfab.com/3d-models/off-shoulder-top-5dac7be571c7464e802cc5aaa08a15c0),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
La versione AIR3 adatta la geometria del capo alla presentatrice e aggiunge pesi
di skinning. Topologia, UV e texture incorporata dell'autore sono conservate.

| Voce | Valore |
| --- | ---: |
| Originale ricevuto | 2.483.712 byte |
| Asset runtime `crop-top.glb` | 2.800.172 byte |
| Vertici | 6.403 |
| Triangoli | 12.052 |
| Texture colore | 2.048 × 2.048 pixel |
| Influenze per vertice | 4, normalizzate |
| Mesh aggiuntive visibili | 1 |

Il convertitore `tools/prepare_crop_top.py` orienta il capo nello spazio di
legatura del corpo e ne adatta larghezza, altezza e profondità. Il margine
inferiore è più alto rispetto alla maglietta originale e lascia visibile il
ventre. Un campo di spostamento regolare segue la superficie corporea senza
cambiare il corpo. La fodera interna del collo, nascosta dietro la schiena,
resta esclusa dalla proiezione esterna: proiettarla come se fosse tessuto esterno
produceva due schegge chiare sul dorso. La separazione dei due strati viene
aumentata di 1,5 mm per lato per ridurre gli attraversamenti durante lo skinning.

I pesi provengono dagli otto vertici corporei più vicini nello spazio di
legatura, sono regolarizzati nello spazio del capo e ridotti alle quattro
influenze maggiori. Il controller collega questi pesi alle ossa esistenti usando
i nomi memorizzati nel GLB. Le sei parti della maglietta originale vengono
nascoste soltanto dopo che il caricamento del nuovo top è riuscito.

I triangoli del torso sicuramente coperti dal top vengono omessi dal disegno.
Spalle, scollatura, braccia e ventre mantengono la pelle del modello originale.
La maschera usa soltanto l'indice di disegno; togliendo il top si recupera
esattamente la geometria sorgente. Le maschere di top e scarpe si compongono:
cambiare le scarpe non ripristina accidentalmente il torso nascosto dal top.

## Due soluzioni per gli stivaletti

Il difetto sul retro della caviglia dipendeva dalla forma del gambale ricevuto,
inclinato in avanti rispetto allo stinco dell'avatar. La nuova calzata corregge
il gambale nelle coordinate dell'accessorio. Non abbassa il tallone del corpo e
non modifica la lunghezza della gamba.

| Scelta | Intervento | Triangoli disegnati, coppia |
| --- | --- | ---: |
| Gambale adattato (`relaxed`) | Parte alta arretrata progressivamente, centrata e allargata intorno alla caviglia | 40.746 |
| Gambale basso (`low-cut`) | Stesso adattamento, taglio orizzontale a 20,5 cm sopra la suola nominale, bordo interno di 3 mm | 30.196 |

Il taglio basso interpola i vertici, le UV e i pesi lungo un piano preciso.
Non elimina interi triangoli attraversati dal piano, cosa che lascerebbe un bordo
a dente di sega. La versione alta conserva il profilo irregolare del bordo della
scansione originale. Suola, tacco e punta mantengono la forma dell'accessorio.

È stata mantenuta la texture fotografica dello stivaletto Aquateknica e la sua
attribuzione CC BY 4.0. Origine, licenze e preparazione delle altre calzature
sono documentate in [Calzature intercambiabili](CALZATURE.md). Le due calzate si
generano dal medesimo GLB ottimizzato, senza aggiungere un altro download di
asset al pacchetto. Le geometrie delle scelte caricate restano in cache per i
cambi di menu; non vengono rigenerate a ogni fotogramma.

## API

```js
import { createClothingController } from './air3-clothing.mjs';
import { createFootwearController } from './air3-footwear.mjs';

const clothing = await createClothingController({ avatarRoot: gltf.scene, rig });
const footwear = await createFootwearController({ avatarRoot: gltf.scene, rig });

await clothing.setStyle('crop'); // 'original' oppure 'crop'
await footwear.setStyle('boot', { fit: 'relaxed' });
await footwear.setFit('low-cut');

// Dopo l'aggiornamento del rig:
clothing.update();
footwear.update();

clothing.getState();
footwear.getState();
clothing.diagnostics();
footwear.diagnostics();

// Rilascio delle risorse e ripristino del disegno originale:
clothing.dispose();
footwear.dispose();
```

`setStyle('boot', { fit })` applica modello e calzata come una singola selezione.
L'ultima richiesta prevale quando i caricamenti si sovrappongono. Gli identificativi
sconosciuti vengono rifiutati prima di cambiare lo stato; un errore di caricamento
mantiene la precedente scelta visibile. Chiudere i controller mentre un asset è
ancora in caricamento non lo lascia attaccato alla scena.

## Collaudo e limiti

Il report `docs/validation/history/lookdev-2.3.0/wardrobe-refinement/report.json` registra hash
dei moduli e degli asset, versione del browser, configurazioni e geometrie
renderizzate. Il collaudo dedicato comprende **24 immagini a 960 × 960**:

- Fronte, lato e retro con maglietta originale e top corto: 6 immagini.
- Fronte, lato, retro e tre quarti posteriore per i due gambali: 8 immagini.
- Top durante due momenti della camminata ACCAD, fronte e retro: 4 immagini.
- Entrambi i gambali negli stessi due momenti della camminata: 4 immagini.
- Top durante `MH_Talk`, fronte e retro: 2 immagini.

Il test controlla inoltre che tutti i vertici animati degli accessori siano
finiti e che il browser non produca errori. Le viste principali sono state
ispezionate per la calzata posteriore e per gli attraversamenti del tessuto.
Le immagini sono generate con Chromium/SwiftShader usando i moduli sorgente:
non costituiscono una misura delle prestazioni GPU. Il collaudo dell'app compilata
e dei suoi menu viene registrato separatamente.

I sei test di `wardrobe-refinement.test.mjs` e `footwear.test.mjs` verificano
maschere reversibili, indipendenza fra top e scarpe, pesi normalizzati, vertici
finiti, legatura dopo l'avvio dell'animazione, caricamenti superati o falliti,
rilascio delle risorse e integrità degli originali delle scarpe. Il validatore
Khronos applicato al nuovo top rileva **zero errori, zero avvisi** e due sole
informazioni su due accessor glTF non più usati; il report è
`docs/validation/history/lookdev-2.3.0/imported-assets/clothing-crop.json`.

Il risultato usa skinning e maschere di disegno, senza simulazione fisica del
tessuto né solver dinamico delle collisioni. Le pose campionate non garantiscono
assenza di compenetrazioni per qualunque animazione futura. Il tessuto non ha una
dinamica indipendente durante i gesti. La cattura della camminata non è stata
registrata specificamente con questi tacchi: il controllo dell'app gestisce gli
appoggi, ma la forma della calzatura non equivale a una nuova cattura in tacchi.

## Ricostruzione

Gli asset runtime sono già inclusi. Python serve solo per riprodurre il fitting:

```sh
python -m pip install -r tools/motion-requirements.txt
python tools/prepare_crop_top.py
```

`--source` accetta un percorso alternativo dell'originale; `--output` permette di
rigenerare in una directory separata. `crop-top.json` riporta hash, dimensioni,
limiti geometrici e descrizione della legatura. Il controller non richiede
librerie aggiuntive o servizi esterni. Per riprodurre le verifiche, dalla directory
`studio-broadcast`:

```sh
node --test --test-isolation=none test/wardrobe-refinement.test.mjs test/footwear.test.mjs
node scripts/qa-wardrobe.mjs
```

Per l'ultimo comando `AIR3_CHROME_PATH` può indicare il browser locale. In
alternativa viene usato il percorso già configurato nel progetto.

La riconversione in una directory temporanea ha riprodotto il GLB identico byte
per byte, senza scrivere nell'asset runtime. La verifica è registrata in
`docs/validation/history/lookdev-2.3.0/wardrobe-refinement/rebuild.json`.
