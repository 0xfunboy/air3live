# Chat Twitch in #AIR3 Live

La chat è un servizio autonomo del modulo live. Non richiede dApp o Eliza e può
leggere il canale Twitch mentre il video viene inviato a Restream. L’ingresso
video di Restream e l’autorizzazione per leggere Twitch sono configurazioni
separate: la stream key del video non autorizza l’accesso alle API della chat.

## Configurazione

1. Registra un’applicazione nella [console sviluppatori Twitch](https://dev.twitch.tv/console/apps).
2. Registra come URL di reindirizzamento OAuth il valore esatto mostrato dal
   pannello #AIR3 Live. Per esempio, se il pannello viene aperto su
   `http://localhost:5890`, la callback è
   `http://localhost:5890/api/live/twitch/callback`.
3. Inserisci Client ID, Client Secret e nome del canale nel pannello. Il nome è
   il login del canale, senza indirizzo web. Abilita la chat e salva.
4. Premi il pulsante per collegare Twitch e completa l’autorizzazione nel browser.

Twitch richiede la registrazione dell’applicazione e la configurazione della
callback. Il flusso implementato è l’**Authorization Code Grant**, con scambio del
codice sul server. Viene richiesto soltanto `user:read:chat`.

Il Client Secret, l’access token e il refresh token restano nel file di
configurazione privato del server. Le API del pannello restituiscono solo lo stato
di autorizzazione, il canale, il nome dell’account collegato e i messaggi. Non
restituiscono tali credenziali al frontend.

Il modulo legge la chat. Non invia risposte, non esegue comandi ricevuti, non
trasforma automaticamente i messaggi in titoli o narrazione e non effettua
moderazione sul canale Twitch.

## Eventi gestiti

| Evento Twitch | Effetto nel pannello |
| --- | --- |
| `channel.chat.message` | Aggiunge il messaggio alla lista |
| `channel.chat.message_delete` | Rimuove il messaggio cancellato |
| `channel.chat.clear_user_messages` | Rimuove i messaggi dell’utente interessato |
| `channel.chat.clear` | Pulisce la chat visualizzata |

Il buffer conserva al massimo 200 messaggi. Gli eventi duplicati vengono
scartati. I marcatori di cancellazione impediscono a un duplicato in ritardo di
far riapparire un messaggio già rimosso. Testo e nomi sono dati in testo semplice;
il frontend deve mostrarli con `textContent`.

## Connessione e recupero

Il client usa EventSub WebSocket su `wss://eventsub.wss.twitch.tv`. Dopo una perdita
ordinaria di connessione si riconnette e ricrea le quattro sottoscrizioni, con
attesa crescente e rispetto di `Retry-After`. Quando Twitch richiede un passaggio
verso un nuovo socket, mantiene aperto quello precedente fino alla conferma del
nuovo, usando le sottoscrizioni trasferite da Twitch.

Il token viene validato all’avvio della lettura e poi ogni ora. Un `401` attiva un
solo refresh condiviso tra le richieste concorrenti; il nuovo token viene
validato prima di salvarlo. Una revoca o un’autorizzazione insufficiente fermano
la chat e richiedono il collegamento dell’account.

La callback OAuth richiede uno stato casuale, monouso, valido dieci minuti e legato
alla sessione dell’operatore che ha iniziato il collegamento. Host e protocollo
dei servizi Twitch sono fissi; i reindirizzamenti HTTP delle risposte API non
vengono seguiti. I dettagli grezzi degli errori remoti non vengono riportati nel
pannello o nei log del modulo.

Twitch non riproduce gli eventi persi durante una disconnessione ordinaria. La
chat mostra quindi lo stato di riconnessione; non inventa o ricostruisce quei
messaggi mancanti. Il passaggio richiesto dal server usa invece il meccanismo di
handover previsto da Twitch.

## API interne del modulo

`src/twitch-chat.mjs` espone `createTwitchChat({ getConfig, saveTokens })` e i
metodi `configure`, `start`, `stop`, `publicState`, `authorize`, `callback`,
`clearAuth`. Il gateway autentica le richieste del pannello e passa l’identificativo
di sessione operatore a `authorize` e `callback`.

`saveTokens(patch, { guard })` inoltra il controllo al gestore delle impostazioni:
il `guard(currentSettings)` deve essere valutato **dentro la coda di scrittura**,
prima di applicare il nuovo valore. Questo impedisce a un vecchio refresh o a una
callback già in attesa di ripristinare credenziali dopo una disconnessione o un
cambio di applicazione. Il controllo prima di una scrittura asincrona, da solo,
non garantirebbe questa proprietà.

`clearAuth` interrompe la connessione e rimuove i token memorizzati localmente.
L’eventuale revoca completa dell’applicazione sull’account Twitch si effettua
dalla pagina Connessioni di Twitch.

## Verifica e limiti del collaudo

I 18 test di `test/twitch-chat.test.mjs` usano risposte HTTP e WebSocket simulati, senza account
reali e senza inviare messaggi a canali pubblici. Verifica:

- OAuth, scope, stato scaduto, riuso dello stato e associazione alla sessione;
- mancata esposizione di token e segreti nei dati pubblici;
- sottoscrizioni, duplicati, cancellazioni e limite del buffer;
- heartbeat, riconnessione ordinaria, passaggio tra socket e arresto;
- refresh concorrente, validazione oraria, revoche e limiti di richiesta;
- annullamento mentre autorizzazione o avvio sono ancora in corso.
- blocco di scritture di token già accodate dopo logout o nuovo collegamento.

Il collaudo con il proprio canale richiede le credenziali dell’applicazione e il
consenso dell’account Twitch. Non è stato dichiarato un collegamento reale a un
canale senza queste credenziali.

## Fonti ufficiali consultate il 27 ottobre 2026

- [Registrazione dell’applicazione](https://dev.twitch.tv/docs/authentication/register-app/)
- [Authorization Code Grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Validazione dei token](https://dev.twitch.tv/docs/authentication/validate-tokens/)
- [Refresh dei token](https://dev.twitch.tv/docs/authentication/refresh-tokens/)
- [Lettura dei messaggi](https://dev.twitch.tv/docs/chat/send-receive-messages/)
- [Tipi di sottoscrizione EventSub](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Gestione degli eventi WebSocket](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)
- [Riferimento dei messaggi WebSocket](https://dev.twitch.tv/docs/eventsub/websocket-reference/)
