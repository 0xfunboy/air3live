import { defaultLook, DEFAULT_LOOK_URL, LOOK_STORAGE_KEY, parseLookPreset, serializeLookPreset, validateLookPreset } from './look-presets.mjs';

export function availableBrowserStorage() {
  try { return globalThis.localStorage; } catch { return undefined; }
}
export async function loadInitialLook({ storage = availableBrowserStorage(), query = globalThis.location?.search || '' } = {}) {
  const response = await fetch(DEFAULT_LOOK_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error('Preset luci e aspetto non disponibile');
  const shipped = parseLookPreset(await response.text());
  const params = new URLSearchParams(query);
  if (params.get('resetLook') === '1') return { preset: shipped, shipped, source: 'package' };
  try {
    const saved = storage?.getItem(LOOK_STORAGE_KEY);
    if (saved) return { preset: parseLookPreset(saved), shipped, source: 'browser' };
  } catch { /* A restricted/private browser still loads the shipped preset. */ }
  return { preset: shipped, shipped, source: 'package' };
}

export class LookController {
  constructor({ lighting, hair, footwear, clothing, storage = availableBrowserStorage(), shipped = defaultLook(), source = 'package' }) {
    this.lighting = lighting; this.hair = hair; this.footwear = footwear; this.clothing = clothing; this.storage = storage;
    this.shipped = validateLookPreset(shipped); this.name = this.shipped.name; this.source = source;
    this.listeners = new Set(); this.disposed = false; this.busy = false; this.error = null;
    this.chain = Promise.resolve(); this.generation = 0; this.lastSaved = null; this.desired = this.getPreset();
    this.storageListener = event => {
      if (event.key === LOOK_STORAGE_KEY && event.newValue && !this.disposed) {
        try { void this.apply(parseLookPreset(event.newValue), { persist: false, source: 'browser-sync' }).catch(() => {}); }
        catch (error) { this.error = error.message; this.emit(); }
      }
    };
    globalThis.addEventListener?.('storage', this.storageListener);
  }
  getPreset() {
    const hair = this.hair?.getState?.() || { style: 'legacy', color: 'chestnut' };
    const footwear = this.footwear?.getState?.() || { style: 'original', fit: 'relaxed' };
    const clothing = this.clothing?.getState?.() || { style: 'original' };
    return validateLookPreset({ schema: this.shipped.schema, name: this.name,
      hair: { style: hair.style, color: hair.color }, footwear: { style: footwear.style, fit: footwear.fit ?? 'relaxed' }, clothing: { style: clothing.style }, lighting: this.lighting.getState() });
  }
  subscribe(callback) { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  emit() { if (!this.disposed) for (const callback of this.listeners) callback(this.getPreset(), this.status()); }
  status() { return { source: this.source, busy: this.busy, error: this.error, saved: this.lastSaved,
    hair: this.hair?.diagnostics?.() || this.hair?.getState?.(), footwear: this.footwear?.diagnostics?.() || this.footwear?.getState?.(), clothing: this.clothing?.diagnostics?.() || this.clothing?.getState?.() }; }
  persist() {
    try {
      if (!this.storage?.setItem) throw new Error('Storage unavailable');
      this.storage.setItem(LOOK_STORAGE_KEY, serializeLookPreset(this.getPreset())); this.lastSaved = Date.now();
    } catch { this.lastSaved = null; this.error = 'Salvataggio locale non disponibile: usa Esporta preset.'; }
  }
  setLighting(value, { persist = true } = {}) {
    if (this.disposed) return;
    if (this.busy) {
      const next = structuredClone(this.desired); next.lighting = value;
      return this.apply(next, { persist });
    }
    this.lighting.setState(value); this.source = 'custom'; this.error = null; this.desired = this.getPreset();
    if (persist) this.persist(); this.emit(); return this.lighting.getState();
  }
  setName(name) {
    const next = structuredClone(this.desired); next.name = name; validateLookPreset(next);
    if (this.busy) return this.apply(next);
    this.name = name.trim(); this.desired = this.getPreset(); this.error = null; this.persist(); this.emit();
  }
  async applyAssets(preset) {
    if (this.hair) {
      await this.hair.setStyle(preset.hair.style); if (this.disposed) return;
      await this.hair.setColor(preset.hair.color); if (this.disposed) return;
    }
    if (this.footwear) await this.footwear.setStyle(preset.footwear.style, { fit: preset.footwear.fit });
    if (this.disposed) return;
    if (this.clothing) await this.clothing.setStyle(preset.clothing.style);
    else if (preset.clothing.style !== 'original') throw new Error('Controller maglietta non disponibile');
  }
  apply(value, { persist = true, source = 'custom' } = {}) {
    const preset = validateLookPreset(value); // Validate the whole file before any mutation.
    if (this.disposed) return Promise.reject(new Error('Look controller disposed'));
    const generation = ++this.generation; this.desired = structuredClone(preset); this.busy = true; this.error = null; this.emit();
    const task = async () => {
      // Unstarted obsolete requests can be coalesced. Field helpers merge into
      // desired, so a shoe change cannot erase a queued hair/color change.
      if (this.disposed || generation !== this.generation) return this.getPreset();
      const previous = this.getPreset(), previousSource = this.source;
      try {
        await this.applyAssets(preset);
        if (this.disposed) return this.getPreset();
        this.lighting.setState(preset.lighting); this.name = preset.name; this.source = source; this.error = null;
        if (generation === this.generation) { this.desired = this.getPreset(); if (persist) this.persist(); }
        return this.getPreset();
      } catch (error) {
        if (!this.disposed) {
          let rollbackError = null;
          try { await this.applyAssets(previous); } catch (caught) { rollbackError = caught; }
          if (!this.disposed) {
            this.lighting.setState(previous.lighting); this.name = previous.name; this.source = previousSource;
            if (generation === this.generation) this.desired = this.getPreset();
            if (generation === this.generation) this.error = `Impossibile applicare il preset: ${error.message}` + (rollbackError ? `; ripristino incompleto: ${rollbackError.message}` : '. Ripristinata la configurazione precedente.');
          }
        }
        throw error;
      } finally {
        if (generation === this.generation) this.busy = false;
        this.emit();
      }
    };
    this.chain = this.chain.catch(() => {}).then(task); return this.chain;
  }
  setHair(style, color = this.desired.hair.color) {
    const next = structuredClone(this.desired); next.hair = { style, color }; return this.apply(next);
  }
  setFootwear(style, fit = this.desired.footwear.fit) {
    const next = structuredClone(this.desired); next.footwear = { style, fit }; return this.apply(next);
  }
  setClothing(style) {
    const next = structuredClone(this.desired); next.clothing = { style }; return this.apply(next);
  }
  reset() { return this.apply(this.shipped, { source: 'package' }); }
  export() { return serializeLookPreset(this.getPreset()); }
  dispose() { this.disposed = true; this.generation++; this.listeners.clear(); globalThis.removeEventListener?.('storage', this.storageListener); }
}
