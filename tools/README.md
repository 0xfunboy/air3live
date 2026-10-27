# Strumenti di ricostruzione e conversione

Aggiornato il 2026-10-25. Il progetto contiene la pipeline portabile usata per
questa consegna e gli strumenti storici impiegati per la prima importazione.
L'avvio del servizio usa gli asset già pronti e non richiede di eseguire questi
strumenti né di installare Unreal Engine.

## Ricostruzione con le sorgenti incluse

Per rigenerare il modello runtime, le texture dei nuovi materiali e i bundle del
browser, eseguire dalla radice del progetto con Python 3 e Node.js 24 o successivo:

```sh
python -m pip install -r tools/texture-requirements.txt
npm --prefix studio-broadcast ci
python tools/rebuild_avatar.py
python tools/bake_avatar_materials.py
npm --prefix studio-broadcast run check
npm --prefix studio-broadcast test
npm --prefix studio-broadcast run build
```

`texture-requirements.txt` fissa NumPy 2.3.5 e Pillow 12.3.0. La ricostruzione del
modello usa NumPy; il bake delle texture usa anche Pillow. Le dipendenze JavaScript
sono fissate da `studio-broadcast/package-lock.json`. I percorsi della nuova
pipeline vengono risolti rispetto agli script e non dipendono dal percorso del
computer sul quale è stato creato l'archivio.

La pipeline usa questi input già inclusi:

- `source-assets/AIR3-runtime.before-quality.glb`: modello ricevuto prima delle
  correzioni, con le animazioni convertite già incorporate.
- `source-assets/AI_MetaHumanIdentity_FaceMesh.sparse.glb`: volto sorgente compatto
  con i target morph originali. È un input di lavorazione, non il modello da
  caricare direttamente nel player.
- `studio-broadcast/public/assets/air3/metadata/air3-missing-metadata.json`:
  metadati esportati da Unreal, usati per controlli facciali e materiali.
- `studio-broadcast/public/assets/air3/textures/`: texture sorgenti necessarie al
  bake, conservate accanto alle derivate in `textures/render/`.

I checksum delle due copie GLB sono in `source-assets/manifest.json`. Il bake
registra gli hash delle texture lette e scritte nel proprio report. Il modello
finale viene scritto in
`studio-broadcast/public/assets/air3/models/AIR3-runtime.glb`; le texture derivate
in `studio-broadcast/public/assets/air3/textures/render/`. I sorgenti rimangono
invariati. Il build aggiorna `studio-broadcast/public/build/` e i riferimenti degli
HTML ai bundle compilati.

Questa ricostruzione parte dalle copie esportate incluse. Non ricrea il progetto
Unreal, il materiale MetaHuman originale, RigLogic o i file FBX sorgenti.

## Ricostruzione di capelli, scarpe e catture umane

Questi passaggi sono **opzionali**: il frontend distribuito usa gli asset già
convertiti. Si eseguono su una copia di lavoro quando si vuole rigenerarli;
`prepare_hair_assets.py` e `retarget_accad_motion.py` aggiornano direttamente i
rispettivi asset e manifest. Dopo una rigenerazione occorre ricompilare il
frontend e ripetere le verifiche, prima di creare un'altra consegna.

Versioni effettive usate per questa revisione:

| Dipendenza | Versione | Utilizzo |
| --- | --- | --- |
| Node.js | 24.19.0 | Convertitore calzature; il progetto richiede Node >=24 |
| Three.js | 0.186.1 | Trasformazioni del convertitore, installato dal lockfile del servizio |
| meshoptimizer | 0.24.0 | Riduzione delle calzature; solo strumento di conversione |
| Python | 3.12.14 | Conversioni Python eseguite per la consegna |
| NumPy | 2.3.5 | Retarget delle traslazioni e delle catture BVH |
| SciPy | 1.17.0 | Rotazioni del retarget ACCAD |
| Pillow | 12.3.0 | Estrazione e transcodifica delle texture dei capelli |
| libwebp | 1.6.0 | Codec WebP presente nel Pillow usato per la consegna |

`texture-requirements.txt` fissa già Pillow e NumPy. Le versioni ammesse in
`motion-requirements.txt` sono più ampie: per riprodurre l'ambiente della
consegna usare i pin indicati qui. Il codec WebP effettivo può variare quando
Pillow è compilato dal sorgente; per confronti identici byte per byte va
controllata anche la versione del codec. Nessuna di queste dipendenze Python,
e neppure meshoptimizer, è necessaria all'avvio del servizio.

Dalla radice del progetto, installare le dipendenze JavaScript senza modificare
il pacchetto di produzione:

```sh
npm ci --prefix studio-broadcast
npm install --prefix tools/converter-deps --no-save --no-package-lock --ignore-scripts meshoptimizer@0.24.0
```

Il convertitore delle calzature cerca automaticamente meshoptimizer nella
cartella separata `tools/converter-deps`, poi nel servizio o nella risoluzione
Node del progetto. Il pacchetto Three.js viene letto dall'installazione del
servizio. Non sono necessari percorsi di un altro computer né variabili di
ambiente legate a una shell.

Esempio **Windows PowerShell**, con ambiente Python locale al progetto:

```powershell
python -m venv .venv-assets
.\.venv-assets\Scripts\python.exe -m pip install Pillow==12.3.0 numpy==2.3.5 scipy==1.17.0
.\.venv-assets\Scripts\python.exe tools/prepare_hair_assets.py --input source-assets/lookdev/hair
node tools/prepare_footwear.mjs source-assets/footwear
.\.venv-assets\Scripts\python.exe tools/retarget_accad_motion.py
npm run build --prefix studio-broadcast
```

Esempio **Linux/macOS**:

```sh
python3 -m venv .venv-assets
.venv-assets/bin/python -m pip install Pillow==12.3.0 numpy==2.3.5 scipy==1.17.0
.venv-assets/bin/python tools/prepare_hair_assets.py --input source-assets/lookdev/hair
node tools/prepare_footwear.mjs source-assets/footwear
.venv-assets/bin/python tools/retarget_accad_motion.py
npm run build --prefix studio-broadcast
```

Gli input necessari sono inclusi:

- `source-assets/lookdev/hair/`: due GLB, due ZIP originali e metadati di
  attribuzione. Il convertitore usa anche le sei texture colore originali
  contenute nello ZIP Artemis; non serve scaricare nuovamente i modelli.
- `source-assets/footwear/`: i due GLB originali, attribuzione e hash.
- `source-assets/motion/accad-female1/`: sette BVH utilizzati dalla demo e
  attribuzione ACCAD. Il retarget legge il modello corrente in
  `studio-broadcast/public/assets/air3/models/AIR3-runtime.glb`.

Tutti e quattro i converter controllati risolvono i percorsi predefiniti dalla
posizione del proprio script, non dalla directory di lavoro. I percorsi
esplicitamente passati dall'utente sono invece relativi alla directory di
lancio, come negli esempi sopra. `retarget_body_translations.py` usa il modulo
locale `sparsify_glb.py`, già incluso; per la ricostruzione completa del corpo
resta preferibile `rebuild_avatar.py`, che conserva l'ordine dei passaggi.

Il convertitore calzature accetta anche una destinazione separata:

```sh
node tools/prepare_footwear.mjs source-assets/footwear --output build/footwear-rebuilt
```

Per un'installazione alternativa di meshoptimizer si può specificare
`--meshopt <file-del-modulo>` oppure `AIR3_MESHOPT_MODULE`. I percorsi nativi,
compresi quelli Windows con lettera di unità, vengono convertiti con
`pathToFileURL` prima dell'import ESM. È accettato anche un URL `file:`.
Il normale avvio non richiede questa opzione.

L'audit finale ha eseguito la conversione delle scarpe da una directory esterna
al progetto, verso una destinazione temporanea: entrambi i GLB risultano
identici byte per byte agli asset consegnati, che sono rimasti invariati.
Il controllo è stato eseguito su Linux; la gestione dei percorsi Windows è
implementata, ma non è stata eseguita una seconda conversione su Windows.
Capelli e retarget non sono stati rieseguiti durante questo audit finale per
preservare gli output già verificati. Report:
`docs/validation/current/converter-portability.json`.

## Strumenti della pipeline attuale

| Strumento | Funzione e dipendenze |
| --- | --- |
| `prepare_hair_assets.py` | Prepara i GLB e le texture dei due modelli di capelli allegati. Richiede Pillow; `--input` indica la cartella con i quattro originali inclusi. |
| `prepare_footwear.mjs` | Riduce e normalizza le scarpe; richiede Three.js del servizio e meshoptimizer 0.24.0 separato. Accetta directory sorgente, `--output`, `--meshopt` e `--help`. |
| `prepare_crop_top.py` | Adatta il top corto fornito all'attuale corpo, trasferisce i pesi e conserva texture/UV originali. Richiede NumPy e SciPy da `motion-requirements.txt`; usa `source-assets/clothing/`, accetta `--source` e `--output`. Dettagli in `docs/TOP_E_STIVALETTI.md`. |
| `retarget_accad_motion.py` | Converte sette catture BVH ACCAD sul MetaHuman corrente. Richiede NumPy e SciPy; scrive le clip in `public/assets/air3/motion/` del servizio e il manifest delle sorgenti. |
| `rebuild_avatar.py` | Esegue retarget e aggiunta dei controlli in sequenza, usando un intermedio temporaneo e gli input inclusi. È l'ingresso consigliato per ricostruire il GLB. |
| `retarget_body_translations.py` | Corregge le traslazioni delle animazioni rispetto alle lunghezze di bind del modello. Usa NumPy e `sparsify_glb.py`; aggiorna `docs/validation/body-translation-retarget.json`. |
| `add_facial_controls.py` | Aggiunge il subset verificato di morph correttivi, preservando geometria e pesi. Usa l'intermedio retarget, il volto sparse e i metadati; aggiorna `docs/validation/facial-subset-validation.json`. I correttivi non equivalgono a un port completo di RigLogic. |
| `bake_avatar_materials.py` | Genera le 12 texture derivate dei materiali. Usa NumPy, Pillow, i metadati e le texture incluse; scrive `public/assets/air3/metadata/material-bake-report.json` all'interno di `studio-broadcast/`. Accetta `--assets` per un'altra cartella di asset compatibile. |
| `sparsify_glb.py` | Libreria e utility di compattazione degli accessor dei morph. Per una conversione autonoma richiede GLB di ingresso, destinazione e `--report`. Il volto compatto necessario alla pipeline è già incluso. |
| `preview-server.mjs` | Serve l'anteprima locale. Avviare con `npm --prefix studio-broadcast run preview`; non ricostruisce gli asset. |
| `validate_glb.cjs` | Validatore opzionale con input GLB e percorso JSON del report. Richiede il pacchetto separato `gltf-validator`, non presente nelle dipendenze del servizio. La variabile `AIR3_GLTF_VALIDATOR_MODULE` può indicare il modulo installato. |
| `package_release.py` | Produce lo ZIP dopo i report QA correnti superati; controlla gli hash del bundle testato, rigenera `SHA256SUMS`, esclude credenziali/cache/registrazioni e verifica il CRC dell'archivio. `--output` sceglie il file di destinazione. |

I dettagli sui canali, le approssimazioni e i parametri dei materiali sono in
[`../docs/MATERIALI_AVATAR.md`](../docs/MATERIALI_AVATAR.md). I limiti e le prove
della consegna sono descritti in [`../docs/VALIDAZIONE.md`](../docs/VALIDAZIONE.md).

## Strumenti storici: input aggiuntivi necessari

Questi file sono conservati per tracciabilità e per eventuali nuove esportazioni.
Non fanno parte della sequenza di avvio o della ricostruzione portabile riportata
sopra. I percorsi predefiniti di alcuni script richiamano la vecchia disposizione
delle cartelle di lavoro: occorre passare esplicitamente i percorsi appropriati.

| Strumento storico | Input o ambiente aggiuntivo richiesto |
| --- | --- |
| `export_missing_metadata.py` | Unreal Editor con il progetto originale, gli asset indicati nello script, Python Editor Script Plugin ed Editor Scripting Utilities. Va eseguito nell'Editor; il normale interprete Python non offre il modulo `unreal`. I metadati necessari alla pipeline attuale sono già inclusi. |
| `optimize_textures.py` | La cartella dei 27 PNG originali esportati e una cartella di output del vecchio pacchetto asset. I PNG raw a risoluzione originale non sono tutti inclusi nella consegna. Questo passaggio non serve a rigenerare le nuove texture `render/`. |
| `convert_animations.mjs` | I file FBX originali, le mesh GLB di riferimento e Three.js. Specificare `--source`, `--output` e `--three`; i default del vecchio workspace non sono portabili. Gli FBX originali non sono inclusi. |
| `fbx-import.mjs` | Modulo di supporto ai convertitori FBX, non comando di avvio. Richiede il percorso di un'installazione Three.js compatibile. |
| `build_runtime_assets.py` | Le mesh GLB separate della vecchia esportazione, texture e animazioni convertite nel layout asset originale. Richiede `--source`; `--package` indica quel pacchetto di lavoro. Le due copie in `source-assets/` non sostituiscono questo insieme completo di esportazioni raw. |
| `validate_animation_world.mjs` | Animazioni convertite, FBX originali e Three.js per confrontare le trasformazioni mondiali. Specificare `--source`, `--output` e `--three`; la verifica non può essere ripetuta dal solo ZIP senza gli FBX. |
| `analyze_animation_motion.mjs` | La vecchia cartella `animations/body-clips.glb`, una cartella `reports/` e Three.js. Specificare `--output` e `--three`; la struttura unificata corrente non usa quel layout di default. |
| `install_studio_assets.mjs` | Installer del precedente pacchetto separato. Richiede `integration/versions.json`, `integration/`, `runtime/`, `models/` e `textures/` nella vecchia struttura, più il servizio destinazione passato con `--studio`. Quell'insieme non è incluso nella consegna unificata: non eseguire questo installer su di essa. Gli asset sono già installati nel percorso corretto. |

## File da conservare con il pacchetto

Conservare `source-assets/`, i metadati, le texture sorgenti e quelle derivate se si
vuole mantenere la ricostruzione descritta. Per il lipsync, conservare anche le
distribuzioni complete `studio-broadcast/vendor/rhubarb/1.14.0/`, comprese licenze
e risorse `res/sphinx/`. Le licenze dei componenti e la provenienza degli asset
sono documentate in
[`../studio-broadcast/THIRD_PARTY.md`](../studio-broadcast/THIRD_PARTY.md).

## Verifica e confezionamento 2.3

- `validate_runtime_assets.cjs`: esegue il validatore opzionale sui sei GLB runtime, compreso il top, e produce `imported-assets-validator.json`. Usa `AIR3_GLTF_VALIDATOR_MODULE` per il pacchetto gltf-validator installato separatamente.
- `verify_repository_preservation.py --base /percorso/release-2.2.zip`: confronto SHA-256 completo dei due snapshot dApp/Eliza, con rilevamento di aggiunte e rimozioni.
- `package_release.py`: verifica esiti, hash della build, entrambi i capi/gambali, marchi e regressione della locomozione prima di creare `AIR3_Studio_Refined_2.3_2026-10-25.zip`.

Le verifiche usano i file effettivi; non richiedono modifiche a dApp/Eliza.
