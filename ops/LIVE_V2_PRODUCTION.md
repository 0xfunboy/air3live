# Live V2 in produzione — 2 novembre 2026

Canale principale airewardrop; mittente chat air3agent. OBS/Unreal precedente fermato dall'operatore prima del cambio. La ricezione dello studio Three.js è stata verificata anche su Twitch. V1 e il bot del canale di test sono disabilitati. Il broadcasting resta separato dal trading.

## Componenti e credenziali

- Gateway di produzione: `air3-live.service`, codice nel repository unico `/home/funboy/air3live` sul branch `main`, stato privato distinto dal test, ambiente editorial production. Il worktree di sviluppo separato non è necessario.
- Voce: servizio TTS editoriale dedicato, porta loopback 8882. Il nome storico contiene air3agent-canary, ma è la stessa istanza qualificata per il broadcaster principale; non avviare un secondo worker sulla stessa porta.
- dApp: `air3-dapp-bridge.service`, snapshot in sola lettura da API pubbliche, con TTL e stati vuoti espliciti.
- Eliza: `air3-twitch-v2-production.service` sulla VPS, processo separato con journal/OAuth privati. Il solo proprietario del rinnovo Twitch è questo processo, con lock e scrittura atomica. Modello GemRouter Twitch, non il modello di trading.

Le credenziali sono fuori repository. Non inserire bearer, OAuth, stream key o dati runtime in Git o nel browser. Il gateway e il bridge leggono lo stesso file privato gateway.env di produzione; non mantenerne due copie divergenti. La destinazione video è RTMPS e il recupero verifica l'hash della destinazione approvata.

## Controllo senza effetti finanziari

```bash
/home/funboy/.local/bin/node /home/funboy/air3live/tools/prepare-airewardrop-production.mjs status
```

Verificare frame che aumentano, canale corretto, renderer hardware e wallpanel.fresh=true. Processo active non significa automaticamente dati freschi. Per riallineare soltanto il bridge, senza riavviare video/TTS/Eliza:

```bash
/home/funboy/.local/bin/node /home/funboy/air3live/tools/prepare-airewardrop-production.mjs bridge
```

Il comando verifica anche una nuova snapshot effettivamente pubblicata. L'override segue il ciclo del gateway e legge il suo token attivo. Il monitor usa i dati pubblici normalizzati, non un iframe della pagina wallboard; le protezioni anti-frame della dApp restano intatte. Con zero trade non si inventano candele, posizioni o PnL.

## Arresto e recupero intenzionali

Prima di cambiare percorso, disabilitare e drenare il broadcaster sulla VPS. In caso di incertezza non avviare un secondo writer o una seconda voce.

`prepare-airewardrop-production.mjs stop` arresta il video e revoca la sua ripresa automatica. `start` è riservato a una ripresa intenzionale dopo verifica che il vecchio encoder sia spento; registra l'approvazione del recupero al boot. Non cambiare la chiave mentre l'encoder è attivo.

`rollback-to-test` ferma la produzione, disattiva gli override di gateway e bridge, e torna al vecchio profilo di test. Non riattiva automaticamente il bot canary. Per tornare alla chat V1 serve prima fermare/disabilitare V2 sulla VPS e ripristinare il token Twitch più recente, non un vecchio refresh token. Il processo finanziario principale richiede un riavvio controllato solo per riabilitare il vecchio client. OBS/Unreal rimane una componente esterna sotto controllo dell'operatore.

La configurazione originale, i dati separati e il commit precedente rimangono disponibili. Nessun downgrade cieco di SQLite, cancellazione di journal o reset di sequenze. Il rollback completo e il riavvio fisico host non sono stati eseguiti durante l'audit.

## Repository unico e riavvio

Tutti i servizi installati (gateway, bridge, TTS editoriale e anteprima opzionale) devono riferirsi a `/home/funboy/air3live`, senza dipendenze dal precedente worktree di sviluppo. Le unità di test restano isolate per stato, porte e credenziali anche quando condividono il codice. L'anteprima privata resta disabilitata al boot.

La produzione ha una dipendenza esplicita dal TTS editoriale sulla porta 8882 e un `WorkingDirectory` esplicito: non dipende dall'eredità del vecchio override di test per questi due valori. Conservare la policy `autorun.json`, l'hash della destinazione approvata, lo stato SQLite e gli ambienti privati; nessuna credenziale va ricreata per spostare il codice.

Prima di rimuovere un worktree, verificare che sia pulito, che il commit sia raggiungibile da `main`, che non contenga dati unici e che nessun processo, unità o configurazione attiva lo utilizzi ancora. Conservare un archivio privato di recupero e usare la rimozione Git del worktree, non una cancellazione ricorsiva generica. Il test del reboot fisico resta distinto da un riavvio controllato dei servizi.

Consolidamento eseguito e verificato il 2 novembre: un solo worktree registrato, quello canonico su `main`; sette file privati verificati con hash invariati; video in crescita a circa 30.9 FPS, monitor fresco e chat riconnessa. Twitch conferma `airewardrop` live dopo il riavvio controllato; una domanda reale ha ricevuto tre messaggi confermati e tre segmenti vocali completati con Rhubarb. Nessun riavvio dei servizi finanziari sulla VPS. Backup privato del worktree precedente e delle unità conservato nello stato utente, fuori Git.

Suite successiva: 249 test, 245 PASS e 4 skip preesistenti; sintassi di 147 moduli valida. Tre casi aggiunti verificano percorsi canonici, dipendenza TTS e working directory esplicite e isolamento dell'anteprima. Un primo controllo non conclusivo ha esercitato il ripristino automatico delle unità precedenti; il controllo finale osserva i frame su una finestra temporale invece di confrontare due letture immediate. Linger attivo, servizi di produzione abilitati e policy di recupero del video preservata. Reboot fisico ancora da provare dall'operatore.

## Audit

Suite remota: 246 test, 242 PASS, 4 skip preesistenti di asset non distribuiti; 146 moduli verificati sintatticamente; 8 test Python TTS PASS. Hash di 47 input/output del manifest frontend verificati contro il bundle distribuito. Riapertura del caso vuoto con un trade reale osservata senza riavvii. Nessun errore nei log gateway, bridge e TTS nella finestra controllata di 45 minuti. In produzione frame in crescita, circa 30.8 FPS nel campione.

Su Eliza sono stati corretti deadline complessiva del drain e autenticazione della fonte volumi; test client 60 Node + 19 TypeScript PASS. dApp verificata con typecheck, test Pacifica/security/browser, test supervisione e osservazione DB/runtime READ ONLY. Nessun ordine o parametro di rischio modificato dall'audit. I test PG opzionali non sono stati eseguiti sul database di produzione.

Il report dettagliato sanitizzato è nel repository Eliza, `packages/client-twitch-v2/AUDIT_2026-11-02.md`. Un audit per campione e regressioni non dimostra assenza assoluta di bug futuri: conservare supervisione, TTL, limiti e separazione dei ruoli.
