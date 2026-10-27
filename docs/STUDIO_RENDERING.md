# airewardrop: rendering dello studio

La revisione 2.2 mantiene il [set ovale](STUDIO_OVALE.md), il nuovo marchio e la
[presentazione dei monitor](MOVIMENTO_STUDIO.md). In regia automatica gli
spostamenti passano al campo largo; l'arrivo a un monitor seleziona una vista
con conduttrice e schermo. Questa pagina descrive le passate e i profili grafici
conservati nella nuova scenografia. Le evidenze correnti sono in
[VALIDAZIONE.md](VALIDAZIONE.md).

Questa revisione ricostruisce il set televisivo attorno a dimensioni coerenti:
avatar visualizzato con un'altezza uniforme di 1,76 m, piano del desk a circa
1,04 m e telecamere con campo verticale di 37° in campo largo e 27° sul presentatore. Il fattore di scala dell'avatar
è uniforme sui tre assi: il renderer dello studio non ingrandisce la testa,
non restringe le spalle e non modifica la misura delle scarpe.

## Luce e superfici

L'ambiente di illuminazione è una scena di softbox costruita in spazio lineare,
con emissioni HDR. `PMREMGenerator` la converte una sola volta in una texture
cube-UV prefiltrata. L'ambiente rimane locale, senza download di HDR o immagini
da servizi esterni. Dopo un ripristino del contesto WebGL viene ricostruito.

La luce diretta usa cinque faretti conici fisici regolabili, distribuiti attorno alla postazione: key frontale destra, laterale destro, fill debole e due controluce. I corpi dei cinque proiettori seguono le rispettive posizioni e orientamenti. Il preset riduce luce emisferica e contributo ambientale. [Luci e preset](LUCI_E_PRESET.md) descrive tutti i parametri. Non viene simulata una global illumination dinamica equivalente a Lumen.

Il set comprende pannelli acustici con istanze, arredi con bordi smussati,
metallo, un piano desk con clearcoat e pannelli di vetro con trasmissione,
indice di rifrazione e spessore. Le superfici dei grafici restano prive di un
vetro sovrapposto per mantenere leggibili testi e indicatori nel video compresso.
Il piccolo schermo del desk riusa il canvas del monitor centrale e riceve gli
stessi aggiornamenti, senza introdurre una seconda sorgente dati.

## Profili

Il parametro `quality` si applica al caricamento della pagina:

```text
/studio?output=1&quality=balanced
/studio?output=1&quality=high
/studio?output=1&quality=software
```

| Funzione | balanced | high | software |
|---|---|---|---|
| Ambiente HDR prefiltrato | 256 | 256 | 128 |
| Ombra key | 1024² | 2048² | 512² |
| Ombre degli altri fari | Fino a 1024², su richiesta | Fino a 1024², su richiesta | Disattivate |
| Riflesso planare | 512², ogni due frame renderizzati | 1024², ogni frame renderizzato | Riflessi dell'ambiente |
| Bloom | HDR, intensità 0,12 | HDR, intensità 0,12 | Disattivato |
| GTAO | Disattivato | 60% della risoluzione lineare | Disattivato |
| MSAA del compositor | Fino a 2 campioni | Fino a 4 campioni | Antialias del canvas |
| Vetro | Trasmissione fisica approssimata | Trasmissione fisica approssimata | Trasparenza alpha semplificata |

Senza selezione esplicita viene usato `balanced` su hardware. Il riconoscimento
di SwiftShader o llvmpipe sceglie `software`; la scelta e il motivo compaiono
nei diagnostics. Una selezione esplicita di `high` resta possibile anche in
software per il collaudo degli shader, ma non implica prestazioni interattive.

Il rendering del pavimento usa una vera camera speculare con piano di taglio.
Il materiale attenua e sfuma leggermente il risultato in funzione dell'angolo
di vista. Questa scelta sostituisce SSR per la superficie planare del set:
non dipende dalla presenza dell'oggetto riflesso nel fotogramma principale.
Il materiale del desk usa invece l'ambiente prefiltrato, senza una seconda
cattura speculare della scena.

## Compositor e skinning

I profili con post-processing usano un target lineare half-float. L'ordine è:
render della scena, GTAO opzionale, bloom, conversione finale ACES/sRGB. Il bloom
ha soglia HDR 1,5, raggio 0,30 e intensità 0,12; il colore ordinario dei monitor
non deve trasformarsi in una superficie luminosa indistinta.

Il G-buffer di GTAO usa materiali normali per ogni mesh. Per le mesh dell'avatar
con influenze supplementari viene applicato lo stesso adattatore di skinning a
12 pesi del rendering principale. Un materiale normale condiviso standard
perderebbe le influenze oltre le prime quattro. Hair cards, ciglia, superfici
trasparenti e rifrangenti sono escluse dal G-buffer, evitando occlusioni
rettangolari opache. Conservano i loro materiali e le ombre nel passaggio colore.

Il riflettore viene aggiornato al massimo una volta nel frame previsto e non
durante il G-buffer: la trasmissione e le passate aggiuntive non innescano una
serie ricorsiva di catture.

## Telecamere e osservabilità

Le modalità pubbliche rimangono `auto`, `wide`, `presenter` e `screens`.
`setCamera(mode, true)` consente una posizione immediata e riproducibile nel
collaudo; l'uso ordinario mantiene una transizione graduale. La promessa `avatarReady` si risolve dopo il primo frame completo con il modello
caricato, così la cattura non parte durante la prima compilazione degli shader.
Un avatar configurato che non si carica rifiuta la readiness: il broadcaster non
può sostituirlo silenziosamente con il manichino. Il manichino è riservato alla
configurazione senza avatar. Perdita del contesto e chiusura del renderer
interrompono una readiness ancora in attesa.
`captureFrame()` esporta il canvas WebGL in PNG senza avanzare animazioni o
clock. Il fotogramma contiene la scena, senza interfaccia del browser o pannelli
operatore.

Il presentatore non viene stirato verticalmente per simulare la respirazione.

I diagnostics indicano il profilo, il motivo della selezione, il motore GPU,
la risoluzione reale, gli effetti attivi, la cadenza del riflesso, i materiali
dell'avatar e i conteggi aggregati delle chiamate di disegno e dei triangoli
di tutte le passate. Questi ultimi non coincidono con i triangoli del modello.

## Limiti della validazione

La compilazione degli shader è verificabile con Chromium e SwiftShader. Le
misure in software non rappresentano la velocità della GPU NVIDIA dell'utente.
La documentazione dei test distingue il collaudo del set con manichino dalle
prove con avatar reale e dalle prove della pipeline audio/video. Nessun dato
di mercato sintetico usato nei fixture di test viene introdotto nella pagina
di produzione.

La resa è una ricostruzione PBR in WebGL. Non riproduce il sistema Lumen, il
path tracing, i materiali proprietari del MetaHuman o tutti gli effetti di
Unreal. Una parità visiva richiede confronti sulle stesse inquadrature e con
gli stessi materiali e pose dell'originale.
