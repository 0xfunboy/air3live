# Identità visiva #AIR3 e AiRewardrop

## Posizionamento nella revisione 2.3

Il marchio aziendale AiRewardrop compare **una volta nel set**, sul fondale, e **una volta fuori dal set**, nella grafica superiore della trasmissione. L’intestazione dei comandi usa #AIR3. La preview del solo personaggio, che non contiene il set, usa un’unica intestazione AiRewardrop.

La scrivania usa il simbolo A circondato dall’arco rosso/blu e la scritta AIR3. Nessun logo viene più dipinto sui tre canvas dei monitor, né sul piccolo monitor da scrivania che condivide il canvas del grafico. I monitor restano dedicati a grafici, telemetria e testo della narrazione.

Il volto e la figura presenti nelle immagini di riferimento **non sono inclusi in nessuno dei nuovi loghi runtime**.

## Asset consegnati

Percorso: `studio-broadcast/public/assets/air3/branding/`.

| File | Dimensioni PNG | Uso |
|---|---:|---|
| `air3-emblem.png`, `air3-emblem.svg` | 1024 × 1024 | Simbolo isolato, favicon e caricamento |
| `air3-lockup.png`, `air3-lockup.svg` | 2160 × 640 | Simbolo con scritta AIR3, scrivania e regia |
| `airewardrop-lockup.png`, `airewardrop-lockup.svg` | 2400 × 344 | Marchio aziendale, fondale e grafica esterna |

I PNG usano un canale alpha reale; il nero mostrato da alcuni visualizzatori è lo sfondo del visualizzatore, non un rettangolo incorporato. Gli SVG contengono contorni e gradienti, senza immagini del personaggio, font remoti o script. Le texture vengono posizionate mantenendo le proporzioni del marchio.

## Fonte e metodo

La fonte è il banner indicato dall’utente, `image-edit-target-ee69adcf30977a71.png`. La copia esatta è conservata in `source-assets/branding/banner-2026-10-25/source-banner.png`; l’hash è riportato nel manifest dei loghi.

Sono state eseguite estrazioni con imagegen in modalità modifica, usando **quel file locale** come riferimento e `transparent_background: true`. I risultati selezionati sono conservati senza ritocchi sotto `source-assets/branding/banner-2026-10-25/`, con prefisso `imagegen-`. L’estrazione del marchio aziendale è stata ripetuta per correggere la grafia.

Le estrazioni raster presentavano bordi irregolari, piccoli fori e grana visibili quando ingrandite. Per l’uso nel renderer sono stati quindi preparati **contorni vettoriali puliti** dei marchi e rasterizzazioni ad alta risoluzione. I colori, la composizione generale e la grafia seguono il banner. La scritta aziendale è stata ricostruita con contorni tipografici; non si dichiara una corrispondenza pixel per pixel al carattere del banner. Il simbolo e le lettere AIR3 sono tracciati SVG. Le versioni raster generate da imagegen restano disponibili per confronto con queste versioni runtime.

`branding-manifest.json` registra fonte, metodo, posizionamento e SHA-256 di ciascun asset corrente. Le immagini originali e le estrazioni non vengono caricate dalla scena; il runtime usa solo i piccoli file PNG finali.

### Brief delle estrazioni

I tre brief applicati all’immagine di riferimento richiedevano rispettivamente:

1. Isolare il logo centrale rosso/blu con la sola scritta AIR3, eliminando persona, sfondo e altri elementi; mantenere forma, colori e testo, su trasparenza reale.
2. Isolare soltanto il simbolo della A circondata dall’arco rosso/blu; nessuna figura, scritta o sfondo.
3. Isolare e ingrandire il marchio AiRewardrop nell’angolo superiore destro, con simbolo triangolare, testo corretto e colori originali; nessun altro elemento e sfondo trasparente.

Questi sono i brief operativi riepilogati, non una trascrizione dei metadati del servizio di generazione. Le seconde prove richiedevano inoltre bordi continui e puliti, senza grana o parti aggiunte.

## Verifica

La matrice browser della build compilata controlla che esista un solo marchio aziendale nella scena e un solo elemento aziendale nella grafica esterna. Le catture del framebuffer mostrano il marchio sul fondale e #AIR3 sulla scrivania. L’inventario di build include i loghi, i relativi hash, HTML e CSS effettivamente collaudati. I conteggi e l’esito corrente sono in `docs/validation/history/lookdev-2.3.0/compiled-visual-qa.json`.
