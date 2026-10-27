# Diagnosi del controllo health nella revisione Presence

`compiled-visual-qa-before-diagnostic.json` conserva l'esito originale FAILED
del primo collaudo V7. Il controllo vedeva un evento Chrome/CDP
`net::ERR_ABORTED` su `/api/health` e interrompeva la prova.

`health-diagnostic.json` registra la successiva riproduzione con timestamp
del worker, del server e di CDP. Cinque probe hanno completato correttamente
la lettura del JSON; tre hanno comunque prodotto l'evento CDP. Le risposte
del server erano HTTP 200 e complete; non era scattato il timer di abort.
Un controllo separato ha riprodotto il comportamento anche senza WebGL.
L'evidenza consolidata è in
[health-cdp-diagnostic.json](../../current/health-cdp-diagnostic.json).

La versione corrente assegna un ID pubblico al probe e conserva l'esito
applicativo. Il gate accetta soltanto l'osservazione CDP correlata allo stesso
ID, con HTTP 200 e JSON completo valido. La registra separatamente, senza
nasconderla. Timeout, risposte non valide, abort senza correlazione ed errori
di asset, HTTP o JavaScript continuano a far fallire la prova. Il timeout di
quattro secondi e il limite di 64 KiB non sono stati modificati.

Questa diagnosi riguarda la divergenza osservata in questi collaudi. Non
attribuisce una causa interna a Chromium e non riscrive gli esiti dei più
vecchi timeout durante il rendering, conservati nello storico.
