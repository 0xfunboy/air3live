// Independent garments contribute reversible draw-index masks to one body.
// Source vertex buffers and bone weights are never edited. Combining masks here
// prevents a shoe switch from restoring torso triangles hidden by the top.
const records = new WeakMap();
export function setBodyDrawMask(mesh, owner, key, keepTriangle) {
  let record = records.get(mesh);
  if (!record && !keepTriangle) return;
  if (!record) {
    record = { original: mesh.geometry, owners: new Map(), cache: new Map() };
    records.set(mesh, record);
  }
  if (keepTriangle) record.owners.set(owner, { key, keepTriangle });
  else record.owners.delete(owner);
  if (!record.owners.size) { mesh.geometry = record.original; return; }
  const signature = [...record.owners].sort(([a], [b]) => a.localeCompare(b)).map(([id, row]) => `${id}:${row.key}`).join('|');
  if (!record.cache.has(signature)) {
    const geometry = record.original.clone(), positions = geometry.attributes.position;
    const indices = geometry.index?.array ?? Uint32Array.from({ length: positions.count }, (_, i) => i);
    const index = [], filters = [...record.owners.values()];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (filters.every(row => row.keepTriangle(positions, a, b, c))) index.push(a, b, c);
    }
    geometry.setIndex(index); record.cache.set(signature, geometry);
  }
  mesh.geometry = record.cache.get(signature);
}
export function releaseBodyDrawMask(mesh, owner) {
  const record = records.get(mesh); if (!record) return;
  setBodyDrawMask(mesh, owner, null, null);
  if (!record.owners.size) {
    for (const geometry of record.cache.values()) geometry.dispose();
    records.delete(mesh);
  }
}
