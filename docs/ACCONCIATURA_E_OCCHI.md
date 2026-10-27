# Acconciatura e occhi della presentatrice

## Stato della revisione

Il profilo runtime è `air3-short-ponytail-2026-10-24-v7`. La nuova acconciatura
rimuove dalla scena il chignon alto, introduce una coda corta posteriore e
alcune ciocche separate che raggiungono collo e spalle. Le iridi sono blu.

È un'acconciatura **ibrida**: conserva una copia delle cards fini dello scalpo
fornito e aggiunge geometria di coda e ciuffi costruita da curve. Non è un groom
nuovo interamente scolpito, né una copia fedele della persona delle immagini.
La fotografia guida colore, raccolto posteriore e ciocche libere; la forma del
viso e il corpo rimangono quelli dell'avatar fornito.

## Geometria e aggancio al rig

`studio-broadcast/public/air3-hair.mjs` genera quattro mesh, per **59.282
triangoli** nella configurazione distribuita:

| Parte | Costruzione |
|---|---|
| Scalpo | Copia delle cards originali selezionata per prossimità ai vertici cranici della scansione; esclusione del chignon e sfumatura dei bordi |
| Coda posteriore | 58 sezioni curve sovrapposte, profilo corto e rastremato, attacco sotto il punto più alto del cranio |
| Ciocche laterali | Quattro fasci da 28 fibre geometriche, radicati alle tempie, con curve e lunghezze asimmetriche; nessuna ciocca attraversa la zona centrale della fronte |
| Capelli fini alle tempie | Piccole superfici rastremate sopra le orecchie |

La geometria derivata dello scalpo viene assestata lungo le normali del cranio:
il 42% dell'eccesso sopra 3 mm viene riavvicinato alla testa. Un limite superiore
seleziona le cards della copia e un fade nel frammento riduce gli estremi del
vecchio raccolto. Le soglie sono calibrate su questo GLB, in metri nello spazio
di bind; non sono un adattatore universale per qualunque testa.

Le superfici sono agganciate a `body__head` attraverso la matrice inversa di
bind completa. L'orientamento naturale del GLB, la scala dello studio e le
rotazioni introdotte dalla routine di sguardo non richiedono correzioni manuali
aggiuntive. L'aggancio si esegue prima che inizi una clip.

La mesh originale `hair__...` rimane disponibile nel GLB e viene solo nascosta.
Le posizioni del viso, gli UV originali, i pesi scheletrici e i buffer del file
sorgente non vengono riscritti. La modifica delle cards avviene esclusivamente
in una nuova geometria in memoria.

## Materiali, attaccatura e movimento

Lo scalpo, la coda e le piccole cards sopra le orecchie riusano gli atlanti dei
capelli forniti. Le porzioni dritte vengono selezionate per UV nello shader,
senza ritoccare il raster. La loro dissolvenza di bordo alleggerisce
l'attaccatura; alpha test, alpha-to-coverage e anisotropia moderata conservano
la profondità. Le ombre ripetono campionamento e deformazione.

I quattro ciuffi laterali sono invece **112 fibre geometriche**, senza mappa
alpha e senza nastri sottostanti. Ogni fibra ha tre lati, 22 segmenti e raggio
iniziale fra 50 e 85 micrometri; le punte si assottigliano e terminano a lunghezze
diverse. Le radici iniziano all'interno del raccolto. La larghezza complessiva
dei fasci resta di 4,7–8 mm, con lieve variazione trasversale e in profondità.

Il materiale delle fibre è marrone opaco: roughness 0,82, specularIntensity
0,022, anisotropia zero ed envMapIntensity 0,30. Questi valori riducono i
bagliori argentati osservati nella prima prova della variante. Le fibre
mantengono ombre dirette e sono escluse dal normale buffer GTAO ridotto,
come le altre superfici dei capelli, evitando un contributo subpixel al pass.

Le fibre richiedono 14.784 triangoli; il totale dell'acconciatura cresce di
13.760 triangoli rispetto alla V6, perché sostituiscono le quattro cards
precedenti. Scalpo, coda e piccole cards temporali conservano esattamente gli
stessi array di vertici, normali, UV e indici della V6. Il confronto degli hash
è registrato nella verifica mirata.

Un ritardo elastico smorzato reagisce ai cambiamenti dell'orientamento della
testa. Il movimento è dell'ordine dei millimetri, limitato a 12 mm. Non è una
simulazione fisica dei singoli capelli e **non comprende collisioni** con
spalle, vestito o arredi. Questa distinzione conta nelle pose estreme.

## API di integrazione

```js
import { createAir3Hair } from './air3-hair.mjs';

const materials = await applyAvatarMaterials(gltf, {
  renderer, assetBase: '/assets/air3', quality: quality.name,
});
const hair = createAir3Hair(gltf.scene, { quality: quality.name });
const rig = new Air3AvatarRig(gltf);

// A ogni frame: prima le ossa, poi la risposta secondaria dei capelli.
rig.update(dt);
hair.update(dt);

console.log(hair.diagnostics());

// Alla rimozione del personaggio.
hair.dispose();
rig.dispose();
materials.dispose();
```

Non duplicare l'aggancio nel vecchio elenco di accessori `hair__`: la nuova
radice `air3_ponytail` è già figlia dell'osso della testa. Il dispose ripristina
la visibilità della mesh legacy e libera le geometrie e i materiali derivati.
Le texture condivise sono possedute dal modulo materiali.

## Occhi blu e distanza fra gli occhi

Il materiale `air3-materials-2026-10-24-v4-blue-iris` ricolora solo la regione
dell'iride. La trama radiale e il chiaroscuro del bake esistente rimangono; la
pupilla resta scura e la sclera non viene tinta. Nei profili più alti rimane la
parallasse contenuta sotto la geometria della cornea, con clearcoat.

La distanza fra i centri degli occhi non è stata modificata. Nella bind pose
fornita è circa 55,9 mm lungo l'asse laterale. Spostare soltanto gli occhi o le
loro ossa separerebbe bulbi, palpebre, ciglia e zone di contatto. Un eventuale
allargamento richiede una correzione coordinata della regione orbitale e dei
suoi correttivi, controllata con pose e blink. Le immagini consegnate sono un
riferimento estetico, non una misura tridimensionale della testa.

## Verifica e limiti

Il test `studio-broadcast/test/hair.test.mjs` carica la geometria reale del GLB,
controlla l'integrità degli array del viso e verifica l'aggancio in presenza di
traslazione, scala del modello e rotazione della testa. Controlla inoltre dati
finiti, pass delle ombre, rimozione e ripristino della mesh originale. La
revisione corrente verifica anche che le nuove ciocche restino lateralmente fuori
dalla zona centrale di fronte e pupille nello spazio di bind.

Le prove di sviluppo hanno scartato una prima superficie continua, troppo
simile a un casco, e ridotto progressivamente i ciuffi opachi e i riflessi.
La validazione del bundle e le immagini della **versione finale compilata**
sono raccolte nei report generali della consegna. Le immagini di sviluppo non
sostituiscono tale verifica.

Restano visibili i limiti delle hair cards nei primi piani molto ravvicinati,
negli incroci delle superfici e nelle pose estreme. Non sono implementati
scattering volumetrico del groom, simulazione a ciocche o collisioni complete.
L'acconciatura non viene presentata come equivalente al groom Unreal originale.

### Controllo visivo mirato V7

Sono stati acquisiti e ispezionati volto e campo medio 960×540 con le stesse
camere e luci della V6, usando il viewer sorgente, Chrome 148 e profilo balanced
su SwiftShader. La prova non ha registrato errori JavaScript, shader o richieste
fallite. È stata scelta la V7 con materiale opaco perché rimuove i nastri scuri
alle tempie senza introdurre il precedente bagliore metallico.

È una verifica funzionale e visiva in rendering software, non un benchmark
della GPU di destinazione. Le fibre più fini rimangono sensibili al
campionamento subpixel nelle inquadrature lontane; scalpo e coda mantengono i
limiti delle cards nei primissimi piani.
