# Capelli importati e varianti cromatiche

Revisione del 25 ottobre 2026. Modulo: `studio-broadcast/public/air3-hair-wardrobe.mjs`.

## Scelta e fitting

La coda **Wavy** è la scelta predefinita del pacchetto: ha una riga centrale, lascia gli occhi visibili, conserva la coda e i ciuffi laterali originali. La coda viene accorciata al 70% lungo il primo osso della catena, senza modificare il corpo. Il volume della calotta dei capelli viene adattato alle dimensioni della testa AIR3; il riferimento resta la geometria MetaHuman originale, non una nuova proporzione della testa.

**Artemis** è disponibile come confronto non commerciale. Ha una frangia più lunga e un dettaglio a ciocche più fine. Il ramo frontale originale viene spostato lateralmente di 4,5 cm nello spazio sorgente, con due pieghe opposte di 0,12 e −0,10 radianti: libera lo sguardo mentre le punte ricadono verso il basso. La terza voce conserva la precedente coda corta del progetto.

| Variante | Triangoli importati | Vertici esportati | Ossa | GLB ottimizzato |
|---|---:|---:|---:|---:|
| Wavy | 4.922 | 4.323 | 17 | 318.136 byte |
| Artemis | 5.455 | 4.042 | 33 | 533.616 byte |
| Coda corta precedente | 59.282 | — | testa del modello | Generata dal modulo preesistente |

Non è stata necessaria una decimazione: entrambi i modelli allegati hanno già un numero di poligoni contenuto. Posizioni, normali, UV, indici dei triangoli, pesi e inverse bind dei GLB importati sono conservati byte per byte. Negli slot di influenza con peso esattamente zero, gli indici ossei inutilizzati sono normalizzati a zero per conformità glTF: 9.791 slot Wavy e 9.267 Artemis. Non cambia alcuna deformazione pesata. Il fitting e l'accorciamento sono trasformazioni runtime reversibili della sola acconciatura. Gli originali sono in `source-assets/lookdev/hair/`. Le due copie di Artemis ricevute erano identiche e non sono state duplicate.

L'aggancio copia la matrice di bind immutabile della precedente acconciatura, sotto `body__head`. Funziona anche dopo l'avvio di una clip o il posizionamento/scalatura della presentatrice nello studio. Il cambio di acconciatura non ricalcola l'altezza del corpo. Le oscillazioni secondarie usano le ossa originali, con pochi gradi di ritardo smorzato; non simulano collisioni con il corpo o i vestiti.

## Sei atlanti originali e colore Espresso

La revisione 2.3 aggiunge la scelta **Espresso / Castano quasi nero** (`#3b2b21`), intermedia fra Nero e Castano scuro. Il menu offre quindi sette colori. I dettagli di tinta, sopracciglia collegate e movimento secondario sono in [VISO_E_CAPELLI_2.3.md](VISO_E_CAPELLI_2.3.md).

Il pacchetto Artemis conteneva già sei atlanti dipinti dall'autore. Sono riutilizzati, così direzione dei capelli, UV e dettagli restano coerenti. Non sono immagini generate con una nuova disposizione delle ciocche.

| ID | Nome nel menu | Atlante originale |
|---|---|---|
| blonde | Biondo | color3 |
| copper | Rame | color1 |
| auburn | Castano ramato | color2 |
| chestnut | Castano | color4 |
| dark-brown | Castano scuro | color5 |
| black | Nero | color6 |

Gli atlanti colore sono WebP a 2048×2048, qualità 90. L'alpha originale è condiviso, la normal map è ridotta a 1024×1024. Tutti i file runtime per entrambe le acconciature e i sei atlanti colore occupano complessivamente 4.400.720 byte. Viene mantenuto un solo atlante colore Artemis residente; il precedente viene liberato al cambio. Modello, alpha e normal sono caricati su richiesta e riutilizzati.

Wavy usa esclusivamente il proprio atlante originale e una tinta shader corrispondente alla palette. La coda precedente usa la stessa palette shader. Queste due modalità non campionano texture Artemis. Un biondo su Wavy è quindi un adattamento cromatico della sua texture, non un trasferimento del materiale dell'altro autore.

### Orientamento delle mappe

Le mappe colore e alpha del sorgente FBX Artemis sono invertite verticalmente rispetto alle immagini incorporate nel GLB Sketchfab. La differenza media tra alpha incorporato e alpha sorgente scende da 106,94 a 0,0257 livelli su 255 dopo il ribaltamento verticale. Il runtime applica `flipY=true` al colore e all'alpha sorgente; mantiene `flipY=false` alla normal estratta dal GLB e alla texture Wavy. Questa correzione evita punte troncate e strisce vuote sul cranio.

I materiali usano alpha cutout, depth write e alpha-to-coverage quando disponibile, con la medesima maschera per le ombre. I capelli sono esclusi dal buffer GTAO ridotto per evitare artefatti da superfici sottili. La specularità è contenuta; le ciocche rimangono hair cards e non sono un groom Unreal.

## Provenienza e licenze

- **Wavy White Ponytail (With Bones)**, zHairezt: [pagina autore](https://sketchfab.com/3d-models/wavy-white-ponytail-with-bones-d3e0ba8904504d6fb5e247346a4e93de), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Il modello è attribuito all'autore e la licenza dichiarata ammette uso commerciale. La descrizione dell'autore dice che la mesh proviene dal Roblox Studio Marketplace e che lui l'ha riggata; questo dato di provenienza è conservato, non trasformato in una garanzia di titolarità.
- **Ponytail 1 (Artemis) – Character Hair (Free)**, CT Reed / continuumreed, remix da antoinepavia: [pagina autore](https://sketchfab.com/3d-models/ponytail-1-artemis-character-hair-free-b15554b4b9934cd6adbcf8669f83f634), [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/). La pagina e l'API correnti dichiarano esplicitamente uso non commerciale. Il readme più vecchio nel file allegato riporta una precedente licenza CC-BY, ma l'autore ha successivamente ristretto la licenza per dubbi sulla provenienza del modello originale. La demo mostra questa distinzione nel menu; Artemis non viene presentata come asset pronto per un utilizzo commerciale.

Sono conservati readme, metadati pubblici dell'API recuperati il 25 ottobre 2026, file originali e SHA-256. Non sono state contattate persone né accettati acquisti o condizioni di checkout.

## API

```js
const wardrobe = await createHairWardrobe(avatar, {
  renderer, quality: 'high', legacyHair, loader,
  style: 'wavy', color: 'chestnut'
});
await wardrobe.setStyle('artemis');
await wardrobe.setColor('blonde');
wardrobe.update(dt);
wardrobe.diagnostics();
wardrobe.dispose();
```

Un caricamento fallito lascia visibile lo stile precedente. Se due richieste si sovrappongono, prevale l'ultima scelta. Gli ID sconosciuti producono un errore esplicito. Il controller possiede e libera anche l'istanza `legacyHair` ricevuta: il chiamante deve conservare solo il controller definitivo per l'aggiornamento e la distruzione.

## Verifica

La convalida Khronos dei GLB finali restituisce **0 errori**, **7 warning Wavy** e **1 warning Artemis**: tutti riguardano la gerarchia originale di mesh skinnate non poste alla radice. Non rimangono warning sugli indici ossei inutilizzati. Il confronto indipendente in `docs/validation/history/lookdev-2.3.0/imported-assets/hair-unused-joints-check.json` verifica che ogni indice cambiato avesse peso esattamente zero e che tutti gli altri accessor siano identici agli originali.

`studio-broadcast/test/hair-wardrobe.test.mjs` verifica aggancio dopo animazione e scala del palco, pesi e posizioni finite sui modelli reali, assenza di modifiche alla geometria dell'avatar durante i cambi, orientamento mappe, sostituzione e rilascio degli atlanti, caricamenti falliti e richieste concorrenti. La revisione visiva usa render frontali, laterali, posteriori, a tre quarti e a mezzo busto del modello reale. I risultati non certificano una resa da groom Unreal né un benchmark GPU.
