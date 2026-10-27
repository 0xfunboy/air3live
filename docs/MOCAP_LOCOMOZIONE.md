# Camminata da motion capture

## Cosa cambia

La passeggiata dello studio usa una registrazione di una performer del **Open Motion Project di ACCAD / The Ohio State University**. Non usa più la traiettoria alternata dei piedi, l'altezza sinusoidale del passo o l'oscillazione delle braccia della versione precedente.

Sono incluse sette clip: fermo, partenza, camminata, arresto, svolta a sinistra, svolta a destra e inversione. Il menu animazioni dell'anteprima permette di esaminarle sul modello, senza traslazione nello spazio. I comandi dello studio `presentMonitor`, `returnHome` e `enableRoaming` conservano l'API precedente; usano adesso le clip retargettate, la distanza del movimento registrato e le transizioni di partenza/arresto.

## Fonte e licenza

Fonte primaria: [ACCAD — MoCap System and Data](https://accad.osu.edu/research/motion-lab/mocap-system-and-data). Nella pagina ufficiale il materiale Open Motion Project è concesso con [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). La licenza permette la distribuzione e l'adattamento anche per uso commerciale, con attribuzione, link alla licenza e indicazione delle modifiche.

I sette BVH originali sono in `source-assets/motion/accad-female1/`. `ATTRIBUTION.md` contiene i crediti; `manifest.json` contiene URL, hash, intervalli dei fotogrammi e hash del modello di destinazione. L'archivio ufficiale completo non è necessario al runtime.

La ricerca ha verificato anche le catture gratuite [Mocap ATLAS / Quantum Stage](https://www.mocapatlas.com/collections/free-mocap-animations), che offrono varianti MetaHuman. La loro [licenza](https://www.mocapatlas.com/pages/license) limita la distribuzione di dati estraibili come sorgenti/clip autonome. Per questa consegna con sorgenti modificabili è stata scelta la fonte ACCAD con attribuzione esplicita.

**Il pacchetto ACCAD originale non è nativamente MetaHuman.** Le clip incluse sono state adattate al rig esatto del modello `AIR3-runtime.glb`; non vengono presentate come un'esportazione Unreal già pronta.

## Retarget e proporzioni

Il convertitore ricostruisce le rotazioni globali del BVH, normalizza la direzione di spostamento conservando la rotazione del bacino nelle clip rettilinee e applica le correzioni fra gli assi di bind dello scheletro sorgente e quelli del modello. Distribuisce la rotazione della colonna sulle cinque vertebre di destinazione. Mantiene le lunghezze, le traslazioni locali e le scale dei segmenti del corpo; il bacino conserva il movimento della cattura, con correzione del livello del suolo.

I 25 canali principali vengono registrati nel modulo locale dei dati. Le ossa correttive usano il proprio bind durante la camminata, evitando che scale di una clip `MH_Talk` precedente contaminino la nuova posa. Visemi, microespressioni e richiamo dello sguardo alla camera continuano a essere applicati dal controller del volto.

I dati sono inclusi nel bundle JavaScript: non occorrono un servizio remoto, un download a runtime, un abbonamento o un modello AI per generare il movimento.

## Movimento nello studio

Il percorso e il gesto verso i monitor sono conservati. Il controller legge la distanza della cattura e adatta il tempo di riproduzione alla velocità di marcia. In prossimità della destinazione usa l'arresto registrato. Per orientarsi usa la variazione di direzione registrata nelle clip di svolta. Nelle svolte sul posto riduce nello spazio l’ampiezza dei passi registrati, mantenendone tempi, rollio del piede e direzioni dei ginocchi; la cattura originale era una svolta durante il cammino.

La stabilizzazione usa il punto di appoggio del tallone o dell’avampiede, scelto dalla velocità e dall’altezza dei marker registrati. Non blocca il rollio della scarpa. I piedi in volo seguono la cattura. Una correzione della quota del bacino, limitata a 20 mm, compensa le differenze di proporzione fra la performer e il modello quando serve a raggiungere un appoggio. Se il contatto resta fuori portata viene rilasciato/proiettato, senza allungare le ossa; la diagnostica distingue errore del risolutore e scorrimento rispetto all’ancoraggio originale. Le svolte strette e il passaggio tra catture indipendenti sono adattamenti della sorgente: non sono un sistema completo di motion matching Unreal.

## API

```js
import { createMocapClips, MOCAP_CATALOG } from './air3-locomotion.mjs';
rig.registerClips(createMocapClips());
rig.setClip('ACCAD_Walk_Female');
```

La selezione manuale di una cattura resta attiva mentre la voce anima il volto. Scegliere un'altra animazione nel menu cambia la selezione. Le catture non vengono aggiunte alla rotazione automatica degli idle: la presentatrice ferma non comincia a camminare per il solo avvio del TTS.

Nell’anteprima Partenza, Arresto e Inversione vengono riprodotti una volta e mantengono il fotogramma finale. Selezionarli di nuovo dopo aver cambiato clip li riavvia. Fermo, Camminata e le due svolte cicliche continuano in loop. La navigazione conserva il proprio controllo di tempo e transizioni.

Diagnostica: `stageMotion.diagnostics().locomotion` riporta fonte, clip, fotogrammi sorgente, tempo, velocità e contatti; `motionCapture: true` e `syntheticGait: false` distinguono il nuovo percorso dalla vecchia camminata procedurale.

## Rigenerazione opzionale

Le clip sono già convertite e compilate nella consegna. Per rigenerarle dopo un cambiamento volontario di rig:

```bash
python3 -m pip install numpy==2.3.5 scipy==1.17.0
python3 tools/retarget_accad_motion.py
npm run build --prefix studio-broadcast
```

Le versioni usate nella consegna sono Python 3.12.14, NumPy 2.3.5 e SciPy 1.17.0. Per creare un ambiente isolato e per i comandi Windows vedere [gli strumenti di ricostruzione](../tools/README.md). I sette BVH richiesti sono già inclusi; non servono percorsi temporanei o download aggiuntivi.

Il convertitore non cambia la geometria del modello. Cambiare il modello o gli assi di bind richiede una nuova verifica visiva; il solo fatto che una cattura sia riproducibile non certifica il retarget su un altro personaggio.

## Riscontro numerico della consegna

`docs/validation/history/lookdev-2.3.0/stage-motion-report.json` contiene il test completo: 2.120 fotogrammi simulati, arrivo alle tre postazioni, tre ritorni e cancellazione di un percorso mentre il parlato cambia stato. In questa esecuzione l’errore massimo rispetto al bersaglio IK è 0,195 mm; lo scorrimento massimo reale del punto di appoggio rispetto al proprio ancoraggio è 11,75 mm. Sono due misure diverse. L’errore di orientamento introdotto dall’IK rispetto alla posa catturata è 0,031°; nessun ginocchio ha invertito il polo registrato e nessuna trasformazione è risultata non finita.

Il massimo angolo planare del piede rispetto alla direzione del corpo è 69,26° durante una svolta registrata. Questa misura orizzontale è distinta dal rollio tallone/punta e non viene presentata come un errore della cattura. Il test verifica che il risolutore conservi l’orientamento catturato. I risultati sono a passo di simulazione fisso di 40 ms, senza rendering; non misurano il frame rate del server o la qualità del retarget su qualsiasi altro modello.
