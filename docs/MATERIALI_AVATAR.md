# Materiali dell'avatar airewardrop

Il renderer ricostruisce i materiali a partire dalle texture e dai parametri
estratti dal progetto Unreal 5.7.4. Le geometrie e gli UV non vengono modificati
dal modulo materiali.

## Integrazione

`studio-broadcast/public/avatar-materials.mjs` espone
`applyAvatarMaterials(gltf, { renderer, assetBase, quality })`.
La funzione va attesa **prima** della creazione di `Air3AvatarRig`, così il
controller può aggiungere il supporto alle dodici influenze ai materiali
effettivamente usati, incluse le ombre. Il risultato contiene `diagnostics` e
`dispose()`.

I file pronti sono in `public/assets/air3/textures/render/`.
La rigenerazione, dalla radice del progetto, è:

```bash
python tools/bake_avatar_materials.py
```

Servono Pillow e NumPy, già elencati nei requisiti degli strumenti texture.
Il processo legge le sorgenti presenti nel pacchetto, crea derivati separati e
produce `metadata/material-bake-report.json` con dimensioni, SHA-256 e formule
approssimate dichiarate. Le texture originali non vengono sovrascritte.

## Cosa è stato ricostruito

| Parte | Sorgente verificata | Trattamento web |
|---|---|---|
| Pelle del volto | Albedo, normal, roughness e cavity originali | Materiale fisico, normali e riflesso ambientale, roughness locale |
| Trucco | Maschere e colori/intensità degli override Unreal | Bake 2K in spazio lineare, mantenendo il dettaglio della scansione |
| Occhi | Maschera iride, sclera colore/normal e IOR 1,336 | Iridi blu tramite shader, dettaglio radiale conservato, pupilla e sclera, clearcoat e parallasse limitata |
| Capelli | Cards e atlanti Compact/Layout2 forniti, nuove curve della coda e fibre geometriche laterali | Acconciatura ibrida: scalpo e coda con alpha test/anisotropia; ciuffi laterali con fibre opache senza alpha |
| Sopracciglia | Atlante originale del groom | Coverage dal rosso, profondità scritta e riflesso moderato |
| Ciglia | Coverage originale del groom | Maschera di opacità, materiale scuro e ombre coerenti |
| Abbigliamento | Albedo originali e geometria delle pieghe | Roughness elevata, sheen del tessuto e trama fine senza displacement |
| Denti, gengive e lingua | Geometria e rig originali, regioni UV misurate | Palette naturale dichiarata come sostituzione procedurale |

### Canali: correzioni al dossier ricevuto

`T_Iris_A_M` è una texture di **dati**, non un'albedo a colori. Il suo aspetto
verde/ciano in un visualizzatore RGB non corrisponde al colore degli occhi.
Il bake precedente conserva una palette nocciola come sorgente intermedia.
La revisione corrente applica **una tinta blu nell'area dell'iride** con lo
shader `eyeRefraction`: conserva la luminanza e il dettaglio radiale, esclude
la pupilla e lascia invariata la sclera. Il cambiamento è intenzionale e segue
le immagini di riferimento dell'utente. Il PNG/WebP di bake non viene
sovrascritto. I parametri Unreal indicano coordinate in una palette color-picker,
ma la palette stessa non è stata esportata: non viene dichiarata una
ricostruzione esatta del colore Unreal.

L'alpha degli atlanti `CardsAtlas_Attribute` è costantemente 255. La coverage
dei ciuffi è nel **canale rosso**. Il materiale non usa più la semitrasparenza
uniforme delle vecchie cards: i vuoti sono realmente ritagliati e la profondità
resta corretta. La coverage usa anche gli override effettivi del materiale:
`OpacityNear/Far = 2` e `OpacityPowNear/Far = 0,5` per i capelli, `0,8` e `0,5`
per le sopracciglia in primo piano. Il solo canale rosso senza questa curva
produceva una capigliatura troppo rada in video. Dopo il confronto nel
browser, roughness e intensità speculare sono state moderate per evitare
punti bianchi e riflessi da filo metallico. La texture Tangent contiene direzioni, non normali della
superficie; la sua proiezione XY alimenta il BRDF anisotropo. Il suo alpha
fornisce il gradiente lungo i capelli.

La coda e le piccole cards sopra le orecchie hanno UV rimappati nello shader
su porzioni dritte dell'atlante originale. Per queste superfici viene letto direttamente il rosso
di `Hair_S_UpdoBuns_CardsAtlas_Attribute.png`, con coverage
`pow(R, 0.72) * 1.20` per la coda e `pow(R, 0.52) * 1.30` per i piccoli
capelli fini sopra le orecchie: l'alpha del bake precedente era già saturato e rendeva
troppo compatte le piccole ciocche. Questo campionamento usa lo stesso file
sorgente, senza generare o ritoccare un'immagine. Le ombre adottano gli stessi
UV e la stessa coverage del materiale visibile.

I quattro ciuffi laterali della V7 non usano queste cards: sono 112 fibre
geometriche con punte rastremate, materiale marrone opaco e nessuna mappa
alpha. Il loro materiale usa roughness 0,82, specularIntensity 0,022,
anisotropia zero ed envMapIntensity 0,30. Le ombre dirette mantengono la
geometria e il movimento delle fibre. Scalpo e coda sono invariati dalla V6.

`air3-hair.mjs` va inizializzato dopo i materiali e prima del rig. La vecchia
mesh completa resta nel GLB ma viene nascosta. Solo la copia usata per il nuovo
scalpo è ritagliata e assestata verso la superficie cranica; la geometria
originale del viso, gli array del GLB, il rig e le texture sorgenti non vengono
modificati. Descrizione, API e limiti sono in
[ACCONCIATURA_E_OCCHI.md](ACCONCIATURA_E_OCCHI.md).

Le maschere cosmetiche sono state ispezionate per canale:

- `FaceEyeLipstickMask`: R ombretto, G eyeliner, B rossetto.
- `FaceFoundationBlusherMask`: R fondotinta, G correttore, B blush.

La maschera cavity modula moderatamente l'occlusione, senza essere dipinta
come colore scuro nel viso. Gli albedo vengono decodificati come sRGB; maschere,
normal, ORM e anisotropia restano dati lineari.

## Differenze dichiarate rispetto a Unreal

Gli shader graph originali non sono inclusi nell'export. I colori e le mappe
sono reali; alcune formule di compositing sono una ricostruzione visiva:

- Il fondotinta conserva il dettaglio e usa un'opacità moderata per evitare
  una superficie piatta e una discontinuità netta con il collo. Nelle zone
  molto arrossate della scansione la cromia del fondotinta viene miscelata
  maggiormente, preservando il dettaglio della luminanza. La normal map
  facciale è attenuata a 0,45 dopo il controllo dei primi piani.
- Gli occhi usano un clearcoat sulla geometria originale della cornea e una
  parallasse dell'iride limitata. Non simulano tutta la rifrazione del modello
  oculare di Unreal.
- La superficie procedurale `EyeOcclusion` resta nascosta: il suo vecchio
  materiale uniforme copriva gli occhi. Le palpebre geometriche producono
  ombre reali; il relativo graph UE non è riprodotto.
- Le mappe delle palette dentali non sono presenti. Una palette di smalto,
  gengive e lingua viene assegnata alle regioni UV misurate. È un sostituto
  esplicito, non un materiale originale recuperato. Una roughness distinta
  per denti, gengive e lingua evita l'aspetto di plastica lucida della prima
  ricostruzione.
- I capelli sono cards con anisotropia; non è dichiarata equivalenza con lo
  scattering delle ciocche di Unreal.
- Il modello fisico della pelle non include un pass completo di subsurface
  scattering e non attiva ancora le mappe delle rughe animate.

Il report del bake separa parametri sorgenti, trasformazioni e approssimazioni.
La verifica del caricamento e della compilazione degli shader è registrata
nei log di collaudo della consegna.
