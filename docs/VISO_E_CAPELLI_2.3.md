# Viso e capelli: rifinitura del 25 ottobre 2026

Questa revisione conserva l'acconciatura Wavy scelta dall'utente e la sua calzata sulla testa. Aggiunge un colore intermedio, un movimento secondario più morbido e un intervento mirato sul trucco e sulle sopracciglia. Le immagini e gli UV originali restano invariati.

## Colore Espresso

Il nuovo ID è `espresso`, visualizzato come **Castano quasi nero**. La tinta sRGB `#3b2b21` è la codifica a otto bit della media in RGB lineare fra i precedenti `dark-brown` (`#4b321e`) e `black` (`#252323`). Il colore dipende anche dal preset luminoso. Le regolazioni dell'utente includono una sorgente laterale blu e un controluce ciano, quindi i riflessi mantengono quelle tinte.

Wavy e la precedente coda V7 applicano la nuova tinta al dettaglio della propria texture. Artemis riusa il suo atlante `artemis-dark-brown.webp` con una correzione cromatica del materiale: non viene richiesto un inesistente `artemis-espresso.webp`, né viene caricata una settima mappa dipinta. Passare da Espresso a Castano scuro riusa la stessa immagine residente. Le sei mappe originali Artemis e la loro attribuzione sono conservate.

Il menu comprende quindi **sette scelte cromatiche**, derivate da sei atlanti originali più la tinta intermedia. Le licenze dei modelli rimangono quelle documentate in [CAPELLI_IMPORTATI.md](CAPELLI_IMPORTATI.md).

## Morbidezza consentita dal modello

La geometria, gli UV, il fitting e la lunghezza della coda Wavy sono quelli della revisione precedente. Il materiale Wavy usa roughness 0,82, intensità speculare 0,09 e sheen contenuto: attenua i riflessi stretti senza eliminare il contributo delle luci.

La coda reagisce alla velocità di rotazione della testa con una molla criticamente smorzata. L'integrazione analitica evita l'instabilità di una molla Euler quando cambia il passo di aggiornamento. La frequenza del sistema è 5,5 rad/s e il ritardo angolare di controllo è limitato a 0,055 radianti, prima dei guadagni delle singole ossa. Una piccola risposta è applicata anche alle articolazioni intermedie e alle punte dei due ciuffi frontali; le loro radici restano ferme.

Questa morbidezza riguarda risposta del materiale e movimento secondario del rig esistente. Non è una simulazione a singolo capello, non aggiunge collisioni con viso e spalle e non trasforma le hair cards in un groom Unreal. Le superfici a ciocche possono rimanere leggibili nei primi piani o nei controluce. Lo shader resta opaco con alpha cutout e scrittura della profondità; non sono introdotti capelli semitrasparenti sovrapposti.

## Trucco sopra gli occhi

Il materiale del volto carica la maschera originale `FaceEyeLipstickMask.png` come dato lineare, con gli stessi UV del colore della pelle. Il canale R controlla l'ombretto e il G l'eyeliner. Il canale B protegge la regione delle labbra. Il colore del viso già preparato viene mantenuto e riceve soltanto un rinforzo localizzato del trucco intorno agli occhi.

L'ombretto usa una tonalità bruna neutra con contributo massimo 0,43 della maschera rimappata. Il liner scurisce il colore fino al 36% aggiuntivo nelle zone previste dalla maschera. Non viene inventata una nuova mappa UV né alterata la texture delle labbra, degli occhi o del corpo. L'intervento usa gli stessi shader con skinning esteso della presentatrice.

`applyAvatarMaterials()` espone `setEyeMakeupStrength(0…1)` per confronti deterministici. Il runtime usa 1. Il collaudo produce una coppia di immagini nella stessa posa con forza 0 e 1, così l'effetto può essere attribuito al trucco e non a una luce o a un'espressione diversa.

## Sopracciglia collegate ai capelli

Il materiale mantiene la mappa di copertura originale delle sopracciglia. La tinta viene derivata dalla scelta dei capelli con una densità più scura, conservando la variazione luminosa dei fili nella texture. La soglia alpha passa da 0,20 a 0,13 per rendere più leggibili le fibre sottili; il materiale continua a scrivere la profondità e a usare la stessa maschera nelle ombre.

Il collegamento è automatico: il wardrobe chiama `root.userData.air3Materials.setHairColor(hex)` all'avvio e dopo una selezione colore riuscita. Se la scelta viene rifiutata o il caricamento fallisce, la tinta applicata non cambia. Il controller del look può ripristinare la configurazione precedente usando le API già esistenti.

La diagnostica del materiale riporta `brows.linkedHairColor` e `brows.tintSrgb`; quella dei capelli riporta `colorSrgb`, `browColorLinked` e i parametri di `softness`. Il collegamento funziona anche per le altre famiglie cromatiche, così una scelta bionda non conserva sopracciglia nere fisse.

## Espressione di riferimento

Nel catalogo del progetto **Leggermente felice** corrisponde a `happy`. `warm` è invece l'espressione Cordiale/Accogliente. I render della rifinitura usano `happy` con intensità 1, come richiesto, insieme ai valori di illuminazione del JSON allegato dall'utente.

## Verifica

I test dedicati verificano aggancio e integrità del modello durante cambi di stile, validità del colore intermedio, riuso dell'atlante originale, sincronizzazione delle sopracciglia e rifiuto di scelte non valide. Il ritardo angolare viene controllato come limitato e comparabile a 30 e 60 aggiornamenti al secondo. Il test del trucco usa lo skinning reale a dodici influenze, la maschera originale come dato lineare e la mappa originale delle sopracciglia.

I render dedicati impiegano il modello reale, il preset dell'utente e materiali/luci High su SwiftShader. Sono esportazioni del framebuffer WebGL. Questo controllo sorgente è distinto dalla successiva matrice dell'app compilata e non misura le prestazioni GPU dell'host finale. I risultati sono in `validation/history/lookdev-2.3.0/hair-face/` quando inclusi dal confezionamento della revisione.
