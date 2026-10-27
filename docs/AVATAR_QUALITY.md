# AIR3: proporzioni, retargeting e controllo del volto

Questa pagina documenta la base geometrica corretta ricevuta nella revisione
2.1. Le misure prima/dopo includono l'acconciatura originale e sono conservate
come confronto della conversione. Il GLB base resta invariato in questa
revisione; [capelli e occhi](ACCONCIATURA_E_OCCHI.md), [sguardo](CAMERA_PRESENCE.md)
e [movimento nello studio](MOVIMENTO_STUDIO.md) sono descritti nelle rispettive
integrazioni. Le prove della consegna corrente sono in [VALIDAZIONE.md](VALIDAZIONE.md).

## Correzione delle proporzioni

Il difetto principale del corpo era riproducibile nei dati delle animazioni.
La posa di bind delle mesh e gli scheletri di riferimento dei FBX corrispondevano,
ma le **tracce di traslazione dentro le clip** contenevano offset statici di un
corpo diverso. Riprodurre fedelmente quelle tracce nel browser allargava il torso,
allungava segmenti degli arti e dei piedi e faceva apparire la testa più piccola.

Esempi misurati nelle clip originali:

| Segmento locale | Bind dell'avatar | Traccia originale | Effetto |
|---|---:|---:|---|
| `upperarm_l`, distanza dal pivot della clavicola | 12,977 cm | 17,810 cm | +37,2% di lunghezza locale |
| `spine_05` | 15,830 cm | 19,440 cm | Torso allungato |
| `foot_l`, segmento della gamba | 39,303 cm | 42,218 cm | Gamba allungata |
| `ball_l`, offset della parte anteriore del piede | 14,168 cm | 16,781 cm | Piede deformato in lunghezza |

La nuova conversione usa:

```text
traslazione finale = bind locale dell'avatar + delta animato della clip
```

Il riferimento è `MH_Idle01_UE`: le traslazioni locali sono costanti su tutte le
ossa salvo il bacino, per cui viene usata la mediana della traccia. La conversione
ha corretto **917 tracce di traslazione nei sette clip**, mantenendo le rotazioni,
le scale animate dei correttivi e le variazioni reali di traslazione.

**Le mesh, gli indici, le UV, i pesi e le matrici di bind restano identici bit per
bit al modello ricevuto.** Non sono stati ingranditi testa e seni, ristrette
spalle tramite scala locale, né rimpicciolite le scarpe con un fattore estetico.
Il rapporto fra le parti torna a quello definito dalla geometria sorgente.

Le precedenti verifiche di conversione FBX controllavano la fedeltà dei campioni
esportati. Quel risultato era corretto ma non sufficiente a stabilire che le
traslazioni fossero adatte alle dimensioni dell'avatar. I nuovi test verificano
anche questa condizione.

### Misure prima/dopo

I risultati seguenti sono al tempo zero di `MH_Idle01_UE`, in unità del modello,
prima della scala uniforme di presentazione nello studio:

| Misura | Prima | Dopo |
|---|---:|---:|
| Distanza fra pivot delle spalle | 38,24 cm | 27,44 cm |
| Altezza approssimata con capelli e scarpe | 186,06 cm | 175,20 cm |
| Distanza fra due vertici estremi punta/tallone della sneaker sinistra | 33,83 cm | 31,55 cm |

La distanza fra i pivot delle spalle non è la larghezza esterna delle spalle.
La misura della sneaker non è una taglia di calzatura. Questi valori servono a
confrontare la deformazione prima/dopo a parità di geometria e posa.

Sono stati controllati **sette clip in cinque istanti ciascuno**. Il report
`validation/avatar-proportion-measurements.json` contiene tutte le misure.
Il rig usa inoltre **126 punti delle suole** per mantenere una scarpa a contatto
con il pavimento durante le animazioni in piedi. Nella revisione 2.1 il
controller scenico assume il controllo degli appoggi con IK durante i passi
e restituisce il controllo al grounding originale dopo il rientro.
La dinamica dei tessuti rimane assente.

## Controlli facciali disponibili

Il nuovo export Unreal contiene **815 nomi**, coincidenti con i 815 indici del
volto sparse. Le verifiche eseguite prima della selezione sono:

1. Stesso numero di target e stessi confini di supporto: 702 testa, 41 denti,
   2 occhio sinistro, 2 occhio destro, 68 cartilagine.
2. Identità di posizioni e indici fra il volto sorgente e il volto runtime.
3. Controllo del lato anatomico e della regione dei delta selezionati.

Sono stati aggiunti **29 correttivi** riconoscibili: palpebre, sopracciglia,
angoli della bocca, labbra, mandibola e cartilagine palpebrale. Restano una
selezione dei correttivi sorgenti, non 29 pose facciali complete.

Il movimento principale è prodotto da **35 controlli scheletrici**. Mandibola
e `LowerLipRotation` vengono coordinati: la seconda catena muove i denti
inferiori e la lingua, evitando la precedente apertura con denti immobili.
I denti superiori restano nella loro catena indipendente.

### Forme della bocca

Il controller supporta le nove forme `A B C D E F G H X` della timeline audio:

| Forma | Articolazione nel rig |
|---|---|
| X | Riposo |
| A | Labbra premute, mandibola chiusa |
| B | Apertura piccola |
| C | Apertura media con labbra più distese |
| D | Vocale aperta, mandibola limitata a 0,23 rad prima della modulazione audio |
| E | Apertura arrotondata |
| F | Labbra raccolte e protese |
| G | Labbro inferiore sollevato per il gruppo F/V |
| H | Articolazione della lingua e apertura contenuta |

La timeline generata dall'analisi audio sceglie forma e istante. L'inviluppo
reale dell'audio modula soltanto l'ampiezza della mandibola tra 0,6 e 1,0 del
valore della forma, evitando aperture eccessive sul parlato piano. Se non è
presente una timeline valida, il fallback è dichiaratamente basato sull'ampiezza:
non viene inventata una sequenza di fonemi dal testo.

La bocca è interpolata per evitare salti. La preview manuale mostra invece la
posa selezionata immediatamente, facilitando l'ispezione.

### Espressioni e movimenti procedurali

Sono disponibili `neutral`, `warm`, `happy`, `sad`, `focused`, `concerned`, `surprised`, con
intensità 0–1. Le espressioni modulano sopracciglia, palpebre, guance e angoli
della bocca; durante la voce la componente emotiva della bocca viene attenuata
per lasciare spazio all'articolazione.

Il rig aggiunge battiti di palpebre, piccoli movimenti dello sguardo e una
posizione rilassata delle palpebre superiori. Le cards delle sopracciglia seguono
la testa e una traslazione verticale contenuta associata all'espressione.

## API del controller

```javascript
rig.setClip('MH_Idle02_UE', { immediate: false });
rig.setTime(1.5);
rig.setEmotion('warm', 0.4);
rig.setSpeech({
  phase: 'playing',
  elapsed: 1.25,
  mouthCue: 'C',
  amplitude: 0.6,
  lipSync: 'rhubarb:pocketSphinx'
});

// Ispezione in anteprima:
rig.setFacialPreview({ mouthCue: 'F', blink: 0, gazeX: 0, gazeY: 0 });
rig.clearFacialPreview();
```

`setSpeech` riceve lo stato corrente campionato sul clock audio dal player.
Il controller non crea un proprio timer per ricostruire il tempo della voce.
I tempi delle animazioni corporee restano indipendenti dal riconoscimento audio.

## Shading e passaggi aggiuntivi

`patchSkinMaterial(material, sets)` è esportato e compone il supporto a 8/12
influenze con lo shader preesistente. La clonazione conserva `onBeforeCompile`
e la cache key dei materiali fisici. Il medesimo adattamento viene usato nei
passaggi delle ombre e può essere applicato al materiale delle normali per GTAO.

La normalizzazione dei pesi è ripristinata una sola volta per geometria. Un cambio
di materiale può aggiornare gli shader senza moltiplicare nuovamente i pesi.

## Verifiche e limiti

- `validation/avatar-source-integrity.json`: 143 array di attributi su 20
  primitive confrontati bit per bit; 177.057 vertici geometrici complessivi.
  Tutte le matrici di bind e gli indici dei joint sono invariati.
- `validation/body-translation-retarget.json`: tracce corrette, baseline,
  lunghezze e hash delle due fasi di conversione.
- `validation/facial-subset-validation.json`: nomi, indici sorgenti, regione,
  vertici interessati e ampiezza dei 29 correttivi.
- `validation/avatar-rig-tests.txt`: nove verifiche automatiche, compresa
  traslazione nei sette clip, skinning, composizione shader, movimento dei denti,
  reset delle pose e contatto dei piedi con una trasformazione dello studio.
- Verifica visiva nel browser: chiusura delle palpebre e forme D/F/G/H osservate
  sul modello reale, con materiali e rendering WebGL, senza errori JavaScript.

**Il controller non è un port di RigLogic e non certifica parità facciale con
Unreal.** Non riproduce tutti i correttivi combinati, il solve della lingua di
Unreal, i dettagli delle rughe dinamiche o la simulazione dei tessuti. Le forme
sono articolazioni scheletriche contenute, calibrate sul modello ricevuto e
integrate con correttivi verificati. L'identità geometrica rimane quella del
sorgente.

Per una parità facciale verificabile servono una sequenza di riferimento Unreal
con gli stessi controlli e tempi, oppure pose facciali complete già risolte sul
medesimo rig. Un solo nome di morph o la lista completa dei correttivi non
sostituisce tale riferimento.

## Ricostruzione dal solo ZIP

I due sorgenti necessari sono inclusi in `source-assets/`. Con Python e NumPy:

```sh
python tools/rebuild_avatar.py
```

Lo script esegue il retargeting delle traslazioni e poi aggiunge i correttivi
selezionati. Il GLB risultante viene scritto nel percorso già usato dallo studio.
Le mappe dei materiali hanno una pipeline separata descritta nella documentazione
dei materiali. Gli originali sotto `source-assets/` rimangono invariati.
