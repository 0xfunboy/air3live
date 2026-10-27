# Prima cattura Presence con metadato di regia

Esito originale FAILED conservato. Voce, completamento, cancellazione, codifica e chiusura erano stati verificati prima dell’ultima asserzione, ma il riepilogo renderer del broadcaster non includeva stageMotion. La prova non poteva attestare esplicitamente il monitor raggiunto dal comando.

La revisione del riepilogo aggiunge stageMotion, camera effettiva e capelli senza modificare rendering o playback. Il test viene rieseguito con la medesima asserzione: la destinazione deve risultare left nel renderer finale. L’esito definitivo è in ../../current/avatar-smoke/.
