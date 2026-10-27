# Comandi di regia associati alla narrazione

Il producer può suggerire alla conduttrice di presentare uno dei monitor o tornare alla posizione centrale mediante un campo opzionale nell'API esistente. L'estensione non richiede modifiche ai repository dApp o Eliza già inclusi.

## Esempio

Inviare al gateway `POST /api/narrations`, con il consueto header di autorizzazione del producer:

```json
{
  "id": "commento-monitor-001",
  "language": "it",
  "text": "Osserviamo adesso il grafico sul monitor centrale.",
  "emotion": { "name": "focused", "intensity": 0.3 },
  "presentation": { "action": "monitor", "monitor": "center" }
}
```

Le forme ammesse sono precisamente:

| Intento | Campo `presentation` |
|---|---|
| Monitor sinistro | `{"action":"monitor","monitor":"left"}` |
| Monitor centrale | `{"action":"monitor","monitor":"center"}` |
| Monitor destro | `{"action":"monitor","monitor":"right"}` |
| Ritorno alla postazione | `{"action":"home"}` |
| Nessun comando | Omettere il campo |

Gli altri valori, `null`, gli array, i nomi di monitor sconosciuti e le proprietà aggiuntive producono HTTP 400 con `INVALID_PRESENTATION`. Il payload è una scelta limitata di regia, non contiene codice eseguibile, URL o coordinate di movimento arbitrarie.

## Momento di esecuzione

Il gateway salva il comando insieme alla narrazione e lo restituisce al player che ottiene il lease. Il player lo rende disponibile nel proprio stato; il frontend avvia l'azione una sola volta quando cambia `currentJob` e la fase diventa `playing`. Il suono continua a usare il clock Web Audio e il percorso di autorizzazione esistente.

Il comando avvia il gesto o lo spostamento in parallelo al parlato. Non è una marcatura temporale di una parola e non introduce una pausa artificiale dell'audio per attendere la destinazione. Un producer può omettere il campo per lasciare la conduttrice alla posizione attuale e inviare un successivo comando `home` per il rientro. Cancellazione, disconnessione e completamento eliminano il metadato attivo del player; l'eventuale rientro scenico segue la gestione della regia frontend.

## Compatibilità e idempotenza

La migrazione SQLite aggiunge soltanto la colonna nullable `presentation_json`. Le righe precedenti espongono `presentation: null` al claim. Quando il producer omette il campo, la sequenza JSON usata per il contenuto hash resta esattamente quella della versione precedente: i retry di un vecchio ID restano riconosciuti.

Quando il campo è presente, partecipa all'hash del contenuto. Lo stesso ID con un monitor diverso o con `home` produce HTTP 409 `IDEMPOTENCY_CONFLICT`. L'ordine delle chiavi del piccolo oggetto in ingresso non altera l'hash, perché il comando viene normalizzato prima della memorizzazione.

Il lease unico, gli heartbeat, la cancellazione, la prevenzione del replay e i timeout audio restano quelli della pipeline esistente. Il metadato di regia non viene trasmesso al server TTS.

## Catalogo emozioni

`GET /api/emotions` e `GET /api/expressions` sono disponibili sia nel gateway sia nella preview, senza token. Restituiscono i nomi canonici `neutral`, `happy`, `sad`, `surprised`, `warm`, `focused`, `concerned`, insieme alla mappa degli alias italiani accettati. Sono endpoint di sola lettura; non espongono testo delle narrazioni o credenziali.

## Verifica

```bash
cd studio-broadcast
node --test test/presentation.test.mjs test/gateway.test.mjs test/frontend-player.test.mjs
```

I test nuovi coprono validazione rigorosa, conflitto d'idempotenza, persistenza e claim dopo riavvio, migrazione da un database senza la nuova colonna, hash dei producer precedenti, trasporto del comando via HTTP e pulizia dello stato alla cancellazione/completamento. I test esistenti di autorizzazione e lease vengono rieseguiti insieme.
