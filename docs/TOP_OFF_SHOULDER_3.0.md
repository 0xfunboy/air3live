# #AIR3 Live 3.0: top off shoulder

La maglietta off shoulder fornita dall'utente è stata rifinita come nuovo
abbigliamento predefinito. La maglietta originale rimane selezionabile dal menu.

## Forma e ancoraggio

Il convertitore applica una compressione verticale nominale del **15%**, mantenendo
la quota superiore di aggancio. Non scala il corpo, le ossa o la larghezza della
maglia. Il successivo adattamento alla superficie reale del busto mantiene lo
spazio necessario tra stoffa e pelle: la riduzione effettiva dell'altezza finale è
**13,45%** rispetto all'asset della revisione 2.3.

| Misura sul modello in posa di riferimento | Revisione 3.0 |
| --- | ---: |
| Rialzo dell'orlo inferiore | 41,56 mm |
| Variazione della quota superiore complessiva | −0,016 mm |
| Escursione verticale del bordo frontale centrale prima | 14,35 mm |
| Escursione dello stesso bordo dopo | 0,99 mm |
| Vertici | 6.403 |
| Triangoli | 12.052 |

La scollatura a W richiedeva un intervento locale: la sola riduzione d'altezza non
avrebbe eliminato gli avvallamenti. Il bordo è ora una scollatura a barca quasi
rettilinea, raccordata gradualmente al petto. Le pieghe del seno sono state
rialzate insieme al resto del tessuto, con una correzione locale aggiuntiva massima
di 9 mm. La schiena e l'attacco delle maniche mantengono la propria forma.

Le misure del bordo sono prese nella posa di riferimento. La prospettiva e la
deformazione durante le animazioni producono una curvatura naturale nei render.

## Bianco e tessuto

Il materiale ha ora base bianca e rugosità 0,92. Il grigio e le ombre già dipinte
nella texture originale vengono attenuati nello shader, preservando UV e dettagli.
Un sottotono crema nelle zone chiare e un lilla molto tenue nelle zone scure danno
variazione al bianco. Una trama procedurale fine, filtrata in base alla dimensione
del pixel, evita di aggiungere immagini pesanti o moiré alle riprese in movimento.

Non sono stati sostituiti o rigenerati i pixel della texture fornita: il colore
viene trasformato dal materiale durante il rendering. La luce continua a
determinare la luminosità reale del tessuto, quindi il retro in ombra appare più
scuro del davanti illuminato. Il materiale non è emissivo.

## Skinning e integrità

Dopo il nuovo adattamento sono state ricalcolate le normali e trasferiti di nuovo
i quattro pesi ossei principali per ogni vertice, normalizzandoli. Topologia e UV
restano identici al file sorgente. La maschera reversibile del torso coperto è
stata rialzata con l'orlo: la pancia esposta mantiene la superficie originale.

Il modello dell'avatar è invariato:

`ec6c44a83ecd55083558dd8f30f5287c3eb3161093f7e525468fcc9ffe9ffb7d`

Asset aggiornato `studio-broadcast/public/assets/air3/clothing/crop-top.glb`:

`a7f45020f75d775a79ead6b1b8006f4ee89cc3f4ada3251efcebe6e4fd3735d7`

Il sorgente rimane `source-assets/clothing/off_shoulder_top.glb`, autore DaaGHrii,
licenza CC BY 4.0. La procedura `python tools/prepare_crop_top.py` riproduce l'asset
in modo identico byte per byte.

## Verifiche

I test `crop-top-fit.test.mjs` controllano ancoraggio, rialzo dell'orlo, rettifica
del bordo, UV, triangoli, conservazione della texture, normali e normalizzazione
dei pesi. I test esistenti dell'abbigliamento verificano cambi di maglia,
caricamenti concorrenti, errore di caricamento e composizione delle maschere con
gli stivaletti.

`docs/validation/live-3.0/wardrobe-refinement/fit-measurements.json` contiene le
misure confrontate con il pacchetto 2.3. Il report e i render nella stessa cartella
documentano le viste davanti, dietro e laterali, anche durante parlato e camminata.

La maglia usa skinning e maschere reversibili. Non è presente una simulazione
dinamica del tessuto o un risolutore generale di collisioni: le pose campionate
sono state controllate, ma non certificano qualsiasi futura animazione esterna.
