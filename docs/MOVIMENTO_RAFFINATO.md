# #AIR3: svolte, spalle e raccordi della camminata

Revisione del 25 ottobre 2026. Le correzioni conservano le catture umane ACCAD Female 1, il modello GLB e le lunghezze dello scheletro. Il corpo non viene riscalato per nascondere i difetti.

## Comportamento consegnato

- La partenza e l'orientamento verso il monitor usano una sequenza finita di svolta con un appoggio. Le inversioni più ampie durante il rientro usano una sequenza con due appoggi. Non si ripete una clip di svolta fino a raggiungere l'angolo richiesto.
- L'asse della svolta passa per la proiezione del bacino. Il centraggio iniziale considera lo scheletro, mentre il precedente centro ricavato dall'ingombro visibile poteva essere spostato da capelli e abiti.
- Le spalle conservano la posizione di riferimento di `MH_Idle01_UE`, con una variazione contenuta derivata dalla cattura. Restano le rotazioni e l'oscillazione delle braccia registrate.
- Partenza, camminata e arresto sono raccordati a fasi compatibili della cattura. La distanza di un numero intero di passi viene adattata al percorso; la radice non viene spinta fino al punto finale al termine di una clip.
- Le due animazioni continuano ad avanzare durante un raccordo. Il piede mantiene il suo orientamento registrato e il passaggio fra appoggio del tallone e dell'avampiede trasferisce la correzione senza riportarlo alla posizione non stabilizzata.
- Il percorso è arrotondato negli angoli. La velocità rallenta durante un cambio di direzione, evitando che la radice percorra subito il segmento successivo mentre il corpo sta ancora ruotando.
- La svolta di rientro verso destra usa una variante specchiata della stessa cattura a 180°, con scambio dei giunti e degli appoggi sinistra/destra. Non si applica una rotazione della radice in senso opposto ai passi registrati.

## Cause verificate

### Spalle troppo basse

La cattura ACCAD ferma collocava gli attacchi delle braccia circa 36–55 mm sotto la loro posizione nella posa originale, mentre il collo manteneva quasi la stessa altezza. Le clavicole retargettate avevano un orientamento locale distante circa 22–28° dalla posa originale. Questo produceva il collo visivamente troppo lungo.

Il convertitore ricava adesso la posa locale di riferimento delle clavicole da `MH_Idle01_UE`, misura lo scostamento della cattura rispetto al suo fermo e applica solo una frazione limitata di quello scostamento. La variazione massima ammessa è 4,2°. Il ricalcolo delle rotazioni locali delle braccia conserva il loro orientamento registrato nello spazio del corpo.

Il sampler corregge anche un doppio passaggio attraverso la posa bind durante l'applicazione parziale dello strato locomozione: le ossa mappate sono interpolate direttamente dalla posa corrente alla cattura. La fase intermedia non deve abbassare o allargare le spalle.

### Scatti al termine dei raccordi

La precedente chiamata `q.slerpQuaternions(previous, q, weight)` usava la destinazione anche come secondo operando. Nell'implementazione Three.js utilizzata, `slerpQuaternions` copia prima il primo operando nella destinazione, sovrascrivendo quindi il valore del secondo. Il risultato restava sulla vecchia posa fino alla fine del raccordo, poi saltava alla nuova.

La correzione evita l'alias e mantiene in avanzamento anche la cattura uscente. Un test campiona il corpo immediatamente prima e dopo la fine del crossfade e verifica l'assenza del salto. I raccordi interrompibili conservano l'offset della posa già miscelata.

Altri scatti provenivano dalla stabilizzazione dei piedi: il cambio fra tallone e avampiede ricreava l'ancora nella posa non corretta; inoltre una correzione del bacino poteva rendere pienamente vincolato anche un contatto quasi rilasciato. Ora l'offset passa al nuovo punto d'appoggio, il rilascio segue il raccordo e l'abbassamento correttivo del bacino si attenua gradualmente. Piccoli vuoti inferiori a 80 ms nelle etichette ottiche di contatto non avviano un nuovo passo.

### Svolte troppo lunghe e fuori asse

Il vecchio ritaglio della svolta a sinistra conteneva soprattutto fotogrammi precedenti alla vera rotazione: produceva circa 30° e veniva ripetuto per raggiungere la destinazione. I nuovi intervalli isolano gli appoggi utili e sono tutti finiti. Il loro andamento angolare viene adattato all'angolo del percorso. Lo scheletro conserva lunghezze e scale; un adattamento della falcata riduce gli spostamenti delle caviglie durante la rotazione sul posto.

## Risultati misurati

Il confronto utilizza lo stesso GLB, la stessa scala di riferimento, lo stesso percorso verso i tre monitor e lo stesso campionamento a 60 Hz. Per ciascuna destinazione vengono eseguiti arrivo, un secondo di presentazione, rientro e 1,25 secondi di assestamento. Il contatto visivo e il parlato sono disabilitati solo in questo confronto per isolare il movimento. Un secondo QA esercita invece il parlato e l'interruzione durante un tragitto.

| Metrica | Versione precedente | Revisione |
| :--- | ---: | ---: |
| Massimo spostamento del piede in un frame da 1/60 s | 682,94 mm | 61,86 mm |
| Massima accelerazione discreta della radice | 48,27 m/s² | 6,88 m/s² |
| Massimo spostamento del bacino in un frame da 1/60 s | 26,75 mm | 19,39 mm |
| Massimo abbassamento dell'attacco della spalla relativo al collo, rispetto alla posa originale | 74,49 mm | 13,92 mm |
| Distanza massima del bacino dall'asse centrale, a svolta assestata | Non misurata nel rapporto storico | 2,30 mm |
| Massimo scostamento del punto d'appoggio vincolato, QA a 60 Hz | Non riportato nel confronto storico | 35,42 mm |
| Massimo errore del solutore IK, QA a 60 Hz | Non riportato nel confronto storico | 0,305 mm |

Lo spostamento del piede per frame comprende anche il movimento intenzionale della gamba in volo: non è una misura di scivolamento della suola. Il drift d'appoggio e l'errore IK sono misure separate. Il valore del pivot è misurato quando il peso della svolta supera il 99% e quello dello strato corporeo supera il 99,9%.

Il QA con parlato e interruzione ha percorso 1.804 frame a 25 Hz, completando le tre destinazioni e il rientro dopo un tragitto annullato a metà. Ha misurato un massimo errore IK di 0,311 mm, drift d'appoggio di 25,84 mm e abbassamento correttivo del bacino di 19,03 mm. Non ha trovato trasformazioni non finite o ginocchia piegate dal lato opposto al polo catturato. I limiti precedenti di 5 mm per l'errore IK, 50 mm per il drift e 20 mm per il bacino sono conservati.

Le misure sono test numerici delle trasformazioni del modello, non benchmark GPU o FPS. La prova in Chromium ha caricato le texture e gli asset reali ed eseguito partenza, camminata, arresto, presentazione e rientro. I render finali dello studio sono verificati separatamente nel QA visivo della release.

## Riprodurre le verifiche

Dalla cartella `studio-broadcast`:

```sh
node --test --test-isolation=none test/mocap.test.mjs test/motion-refinement.test.mjs test/stage-motion.test.mjs
node scripts/qa-motion-refinement.mjs
node scripts/qa-stage-motion.mjs
```

`AIR3_QA_DIR` permette di indicare una directory di uscita diversa. I report riportano hash dei file effettivamente eseguiti e identificano il modello. I file correnti sono:

- `docs/validation/history/lookdev-2.3.0/motion-refinement-report.json`: percorsi finiti e continuità a 60 Hz, 3.269 frame.
- `docs/validation/history/lookdev-2.3.0/stage-motion-report.json`: appoggi, ginocchia, interazione con il parlato e rientro durante un tragitto.
- `docs/validation/history/lookdev-2.2.0/motion-before-refinement.json`: confronto storico prima delle correzioni, con hash dei sorgenti precedenti.

Il convertitore offline si esegue dalla radice del progetto con `python tools/retarget_accad_motion.py` e richiede NumPy e SciPy. Regenera `accad-female1.mjs` e il manifest delle catture. I sette file BVH originali e la loro attribuzione ACCAD / The Ohio State University, CC BY 3.0, rimangono nel pacchetto. La variante specchiata non aggiunge una cattura di provenienza diversa.

## Limiti espliciti

La soluzione adatta catture umane a uno studio e a uno scheletro diversi da quelli del performer. Le svolte brevi utilizzano un appoggio finito con adattamento angolare; non sono nuove catture specifiche per ciascun angolo. La stabilizzazione corregge tallone/avampiede individuati dai marker, non simula tutta la superficie della suola e l'attrito del pavimento. Non implementa motion matching, dinamica degli abiti o collisioni fisiche di Unreal.

La spalla segue una variazione contenuta della cattura, non viene bloccata rigidamente. La gestione del trucco, dei capelli, del fitting degli stivaletti e dell'abbigliamento appartiene agli altri moduli della release. Il GLB corporeo e le sue proporzioni rimangono quelli originali; il relativo SHA-256 è `ec6c44a83ecd55083558dd8f30f5287c3eb3161093f7e525468fcc9ffe9ffb7d`.
