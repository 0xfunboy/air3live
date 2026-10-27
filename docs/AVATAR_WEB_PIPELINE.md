# Pipeline web dell'avatar #AIR3

Questa è la pipeline della revisione integrata. Per diagnosi e misure leggere [AVATAR_QUALITY.md](AVATAR_QUALITY.md); per texture, canali e formule di shading leggere [MATERIALI_AVATAR.md](MATERIALI_AVATAR.md). Il vecchio piano «aggiungere in futuro 15 visemi» è stato sostituito da un rig verificato con nove forme legate all'audio.

## 1. Input conservati e output

| File | Uso | Dimensione |
|---|---|---:|
| `source-assets/AIR3-runtime.before-quality.glb` | Modello assemblato prima della revisione, con le animazioni da correggere | 20.546.552 byte |
| `source-assets/AI_MetaHumanIdentity_FaceMesh.sparse.glb` | Volto originale con tutti gli 815 target in forma sparse | 16.118.384 byte |
| `studio-broadcast/public/assets/air3/metadata/air3-missing-metadata.json` | Nomi dei target, riferimenti materiali e parametri estratti da Unreal | Consultare il file incluso |
| `studio-broadcast/public/assets/air3/models/AIR3-runtime.glb` | Output usato dalla preview e dal broadcaster | 21.666.344 byte |

I due input sono immutati e hanno hash in [source-assets/manifest.json](../source-assets/manifest.json). Il volto sparse è un archivio di lavorazione, non un modello da caricare direttamente nel renderer: conserva anche le limitazioni dell'export originario. Il GLB runtime mantiene 267.252 triangoli dell'avatar, sette animazioni corporee e 29 correttivi facciali. I triangoli non sono una misura della geometria dello studio né del carico di tutte le passate.

Le misure di riduzione texture del vecchio pacchetto descrivevano una precedente fase di conversione. La revisione aggiunge derivati specifici per il renderer; dimensioni e hash aggiornati sono nel [report del bake](../studio-broadcast/public/assets/air3/metadata/material-bake-report.json). Non si attribuisce alla nuova consegna una riduzione totale calcolata su un insieme diverso di file.

## 2. Retargeting delle animazioni corporee

`tools/retarget_body_translations.py` rimuove dai canali di traslazione le distanze statiche del corpo sul quale erano state registrate le clip e applica i delta alla bind pose del personaggio destinazione. La baseline principale deriva da `MH_Idle01_UE`; per il bacino viene usata una mediana perché la traslazione varia nel tempo.

Sono corrette 917 tracce in sette clip. Rotazioni, variazioni animate, geometria, UV, pesi e matrici di bind vengono conservati. Non si applica una scala estetica diversa a testa, spalle o scarpe. Il set applica successivamente una sola scala uniforme per presentare l'avatar a 1,76 m.

L'audit [avatar-source-integrity.json](validation/avatar-source-integrity.json) confronta 143 array di attributi su 20 primitive, oltre alle matrici di bind. Il confronto delle pose in [avatar-proportion-measurements.json](validation/avatar-proportion-measurements.json) misura tutte le clip, non soltanto l'immagine iniziale.

## 3. Nomi e selezione dei correttivi facciali

Il metadato aggiornato contiene 815 nomi, corrispondenti ai target del volto sparse. La verifica non usa soltanto il conteggio: controlla identità di posizioni e indici, supporto delle primitive e regione anatomica dei delta selezionati. La suddivisione è 702 target della testa, 41 delle parti dentali, due per ciascun occhio e 68 della cartilagine.

`tools/add_facial_controls.py` include 29 correttivi selezionati nel runtime. Il [report della selezione](validation/facial-subset-validation.json) registra nomi, indici e supporto. Caricare tutti gli 815 correttivi nel browser aumenterebbe memoria e costo senza fornire, da solo, il solve di RigLogic.

Il controller `public/air3-face.mjs` combina quei delta con 35 controlli scheletrici limitati. Le forme A–H e X articolano mandibola, labbra, denti inferiori e lingua; le emozioni modulano il viso con ampiezze contenute. Blink e sguardo sono procedurali. Non si presenta un piccolo morph correttivo come una posa primaria completa.

Il player sceglie le forme dalla timeline generata sul WAV e campionata con `AudioContext.currentTime`. L'ampiezza modula l'apertura, senza sostituire la timeline quando questa esiste. Mancando un allineamento valido, il fallback all'ampiezza viene dichiarato. La generazione Rhubarb e i suoi tempi sono descritti in [AVVIO.md](AVVIO.md).

## 4. Materiali e skinning nel renderer

L'ordine di caricamento è:

1. Caricare il GLB con `GLTFLoader`.
2. Attendere `applyAvatarMaterials(gltf, { renderer, assetBase, quality })`.
3. Creare `Air3AvatarRig`, ripristinando una volta sola i pesi estesi della geometria.
4. Applicare la scala uniforme del set e attendere il primo frame completo prima della cattura.

`air3-avatar.mjs` conserva fino a 12 influenze per vertice tramite i set aggiuntivi `joints_1/weights_1` e `joints_2/weights_2`. `patchSkinMaterial` compone il precedente `onBeforeCompile` e la cache key; non elimina gli shader di iride o capelli. Lo stesso adattamento è applicato a profondità e ombre e, nel profilo `high`, ai materiali delle normali per GTAO. I pesi non vengono rinormalizzati ogni volta che cambia un materiale.

Le mappe renderizzate sono in `public/assets/air3/textures/render/`, separate dalle sorgenti. Gli albedo sono interpretati come sRGB; normal, maschere, ORM e direzioni anisotrope come dati lineari. Il bake recupera il trucco dalle maschere e dai parametri, e usa la coverage reale delle hair cards. La palette degli occhi nocciola e quella dentale restano sostituzioni dichiarate quando le lookup texture Unreal mancano.

## 5. Ricostruzione portabile

Dalla radice del pacchetto:

```bash
python -m pip install -r tools/texture-requirements.txt
python tools/rebuild_avatar.py
python tools/bake_avatar_materials.py
npm run build
```

`rebuild_avatar.py` esegue retargeting e selezione facciale usando percorsi relativi alla propria posizione. Il bake legge le texture incluse e produce derivati e report. La build JavaScript genera i bundle e verifica i riferimenti alle immagini dei GLB. Nessun passo richiede il precedente percorso assoluto Windows.

SHA-256 del GLB congelato della revisione:

```text
ec6c44a83ecd55083558dd8f30f5287c3eb3161093f7e525468fcc9ffe9ffb7d
```

Per verificare visivamente usare `npm run preview`: frontale, profilo, sette clip, volto, blink, espressioni e nove forme labiali. Il campione vocale incluso mostra il collegamento al clock audio. L'API di ispezione e le verifiche numeriche sono in [AVATAR_QUALITY.md](AVATAR_QUALITY.md); i comandi e i risultati complessivi della consegna sono in [VALIDAZIONE.md](VALIDAZIONE.md).

Il risultato è un adattamento WebGL fedele alla geometria sorgente e con approssimazioni materiali e facciali esplicite. Non trasferisce l'intero sistema MetaHuman, i graph proprietari, i correttivi combinati completi o la simulazione cloth di Unreal.
