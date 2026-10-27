/** Same-origin program state; no streaming credentials enter the rendering page. */
export function mountLiveTitles(container) {
  const element = document.createElement('div'); element.className = 'live-editorial';
  const strap = document.createElement('div'); strap.className = 'editorial-strap';
  const label = document.createElement('span'); label.className = 'editorial-label';
  const title = document.createElement('strong'); title.className = 'editorial-title';
  const subtitle = document.createElement('p'); subtitle.className = 'editorial-subtitle';
  strap.append(label, title, subtitle);
  const ticker = document.createElement('div'); ticker.className = 'editorial-ticker';
  const badge = document.createElement('span'); badge.className = 'ticker-badge'; badge.textContent = 'NEWS';
  const viewport = document.createElement('div'); viewport.className = 'ticker-viewport';
  const track = document.createElement('div'); track.className = 'ticker-track';
  const first = document.createElement('span'), second = document.createElement('span'); second.setAttribute('aria-hidden', 'true');
  track.append(first, second); viewport.append(track); ticker.append(badge, viewport); element.append(strap, ticker); container.append(element);
  let last = '', speed = 65;
  const measure = () => { const width = first.getBoundingClientRect().width; track.style.animationDuration = `${Math.max(4, width / speed)}s`; };
  const observer = new ResizeObserver(measure); observer.observe(viewport);
  return {
    update(state) {
      const key = JSON.stringify(state); if (key === last) return; last = key;
      const enabled = !!state?.enabled; element.hidden = !enabled;
      const hasStrap = enabled && !!(state.title || state.subtitle);
      container.classList.toggle('has-editorial-title', hasStrap); container.classList.toggle('has-editorial-ticker', enabled && !!state.ticker?.length);
      strap.hidden = !hasStrap; label.textContent = state?.label || '#AIR3'; label.hidden = !state?.label;
      title.textContent = state?.title || ''; subtitle.textContent = state?.subtitle || ''; subtitle.hidden = !state?.subtitle;
      ticker.hidden = !enabled || !state?.ticker?.length; speed = state?.speed || 65;
      const text = (state?.ticker || []).join('   •   '); first.textContent = text ? text + '   •   ' : ''; second.textContent = first.textContent;
      requestAnimationFrame(measure);
    },
    dispose() { observer.disconnect(); element.remove(); },
  };
}

export function createProgramClient({ onUpdate, onError = () => {}, fetchImpl = globalThis.fetch, intervalMs = 1200 }) {
  let stopped = true, timer, controller, generation = 0, failures = 0;
  async function poll() {
    if (stopped || controller) return;
    const gen = generation, current = controller = new AbortController();
    const timeout = setTimeout(() => current.abort(), 8000);
    try {
      const response = await fetchImpl('/api/live/program', { cache: 'no-store', signal: current.signal });
      if (!response.ok) throw new Error('Program state unavailable');
      const state = await response.json();
      if (state?.schema !== 'air3.live.program.v1') throw new Error('Invalid program state');
      if (!stopped && gen === generation) { await onUpdate(state); failures = 0; }
    } catch { if (!stopped && gen === generation) { failures++; onError(); } }
    finally { clearTimeout(timeout); if (controller === current) controller = null;
      if (!stopped && gen === generation) timer = setTimeout(poll, failures ? Math.min(10000, intervalMs * 2 ** failures) : intervalMs); }
  }
  return { start() { if (!stopped) return; stopped = false; generation++; void poll(); },
    stop() { stopped = true; generation++; clearTimeout(timer); controller?.abort(); controller = null; } };
}
