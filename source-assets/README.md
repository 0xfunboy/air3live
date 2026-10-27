# Sorgenti dell'avatar

Questi due file sono inclusi per rendere la ricostruzione del modello runtime
riproducibile dal solo archivio. Il server non li espone come asset pubblici.

- `AIR3-runtime.before-quality.glb`: copia esatta del modello ricevuto nel
  passaggio di consegne, prima della correzione delle traslazioni delle animazioni.
- `AI_MetaHumanIdentity_FaceMesh.sparse.glb`: copia compatta del volto sorgente,
  con tutti gli 815 indici morph conservati. È un archivio di lavoro: conserva
  anche problemi di skinning dell'export originale e non va caricato nel player.

Con Python 3 e NumPy installati, eseguire dalla radice del progetto:

```sh
python tools/rebuild_avatar.py
```

Lo script scrive il GLB pronto nel percorso previsto dal player e aggiorna i due
report di conversione. Le texture e i materiali runtime sono gestiti separatamente.
Il manifest contiene dimensioni e SHA-256 delle copie sorgenti immutabili.

## Riferimento vocale

`MT_Voice_Test.flac` conserva la registrazione fornita nel precedente archivio
degli asset. Il campione nella preview è l'estratto fra 10 e 22 secondi, convertito
in WAV PCM16 mono a 24 kHz. Provenienza e checksum del WAV e della timeline sono
in `studio-broadcast/public/assets/air3/demo/PROVENANCE.json` rispetto alla radice
del progetto. La voce viene usata anche come risposta deterministica del provider
locale nei test della pipeline, senza simulare un benchmark di inferenza TTS.
