# Movimento della conduttrice nello studio

Il controller `studio-broadcast/public/air3-stage-motion.mjs` aggiunge un percorso scenico locale al rig fornito. La conduttrice può raggiungere il monitor sinistro, centrale o destro, indicarlo con un gesto aperto e tornare al punto iniziale. L'attivazione automatica è disabilitata all'avvio.

## Camminata e appoggio

La camminata usa sette catture umane della raccolta Female 1 di ACCAD / The Ohio State University: fermo, partenza, camminata, arresto, svolta sinistra, svolta destra e inversione. I BVH originali, l’attribuzione CC BY 3.0 e la conversione riproducibile sono inclusi. Il dettaglio tecnico è in [MOCAP_LOCOMOZIONE.md](MOCAP_LOCOMOZIONE.md).

Posa, ritmo dei passi, oscillazione delle braccia e distanza percorsa derivano dalla registrazione. La velocità nominale di marcia è 0,94 m/s; il controller modifica il tempo di riproduzione della cattura. Le partenze e gli arresti hanno la velocità variabile della performance. Per girarsi usa la variazione di direzione registrata e riduce l’ampiezza spaziale dei passi nelle svolte sul posto. I movimenti non sono generati da traiettorie sinusoidali dei piedi.

L’appoggio viene stabilizzato sul tallone o sull’avampiede secondo i marker a bassa velocità e vicini al suolo nella cattura. Un risolutore a due segmenti usa le lunghezze reali del modello e la direzione di flessione del ginocchio registrata. Conserva l’orientamento della scarpa, compreso il rollio tallone/punta. Una correzione del bacino, applicata solo quando necessaria e limitata a 20 mm, compensa le differenze di proporzione della performer; i segmenti ossei non vengono allungati. I contatti irraggiungibili vengono rilasciati entro il volume raggiungibile. La diagnostica separa l’errore verso il bersaglio IK dal vero scorrimento del punto di appoggio.

Le pose mocap vengono applicate dopo il mixer del corpo e prima dello sguardo e della sincronizzazione di abiti e testa. Il rig ripristina prima la posa base del fotogramma, evitando che le correzioni si accumulino. Durante lo spostamento il corpo mantiene la cattura, mentre la voce continua a guidare il volto. Il sistema originario di appoggio del rig viene sospeso mentre il controller gestisce i piedi e riattivato dopo il ritorno e la transizione alla posa idle.

## Presentazione dei monitor

I percorsi e le postazioni sono quelli documentati in [STUDIO_OVALE.md](STUDIO_OVALE.md). La conduttrice si ferma di tre quarti e usa il braccio dal lato del monitor. La mano indica il grafico con un gesto aperto, mantenendo un margine di flessione del gomito; non raggiunge fisicamente la superficie dello schermo. Il gesto entra ed esce gradualmente.

Durante la camminata lo sguardo segue il percorso per evitare rotazioni del collo verso una camera alle spalle. Alla postazione di spiegazione alterna brevi sguardi al monitor e il ritorno verso la camera attiva. Quando cambia destinazione durante un percorso, torna prima lungo il corridoio già percorso e poi riparte. Il ritorno non attraversa direttamente il desk.

## Comandi

L'oggetto `StudioScene` espone `presentMonitor('left'|'center'|'right')`, `returnHome()` e `enableRoaming(true|false)`. I metodi sono inoltrati al controller `Air3StageMotion`.

La modalità automatica attende prima di partire, non comincia durante il caricamento e non avvia una nuova passeggiata mentre il rig sta già parlando. Alterna le tre postazioni e prevede una sosta di spiegazione. Un comando manuale posticipa il prossimo intervento automatico. Disattivare l'automatismo impedisce le nuove partenze programmate; il pulsante di ritorno gestisce esplicitamente la conclusione del percorso in corso.

`diagnostics()` espone fase (`home`, `walking`, `turning`, `presenting`), destinazione, eventuale destinazione successiva, velocità, contatti, errore IK, deriva degli appoggi, peso del gesto e posizione della conduttrice. `locomotion` identifica clip, fonte e fotogrammi della cattura. `moving` è disponibile anche come proprietà per la regia: l’inquadratura ampia permette di vedere il trasferimento tra le postazioni.

## Verifiche e limiti

`test/stage-motion.test.mjs` carica il GLB effettivo, senza decodificare le immagini, e verifica tutti i percorsi, il ritorno, una cancellazione, gli avvii e gli arresti del parlato durante i passi attraverso tutte le clip talk, il sollevamento dei piedi, la distanza dal volume del desk, la finitezza delle trasformazioni e la conservazione delle traslazioni e delle scale dei segmenti degli arti. Durante l'appoggio a pieno peso il test richiede un errore della caviglia inferiore a 5 mm. Il risultato completo della suite va letto nei log correnti della consegna.

Il comando `node studio-broadcast/scripts/qa-stage-motion.mjs` produce inoltre `docs/validation/history/lookdev-2.3.0/stage-motion-report.json`, con hash dei file effettivi, percorsi completati, errori di appoggio, sollevamento, angolo rispetto alla scarpa, distanza dal desk e ambiente della prova. Il tempo simulato a passo fisso non rappresenta un benchmark di frame rate.

Questa integrazione contiene motion capture umana retargettata per il set piano e i percorsi inclusi. Non comprende un sistema generale di motion matching Unreal, scale, ostacoli mobili, simulazione della gonna o collisioni complete tra corpo e capelli. Le svolte strette e le transizioni tra registrazioni sono adattamenti della cattura, con appoggi approssimati e limiti riportati nel dossier. La qualità va valutata anche nel video sulla macchina di destinazione: i controlli numerici non sostituiscono la verifica visiva.
