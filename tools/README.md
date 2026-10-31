# Tools & Utilities

This directory contains standalone utility scripts for local development and offline inspection.

## Preview Server (`preview-server.mjs`)

A lightweight, zero-dependency read-only HTTP static preview server for local development and visual inspection.

### Usage

```bash
# Preview studio assets from repository root:
npm run preview

# Or run directly with custom port:
node tools/preview-server.mjs --studio studio-broadcast --port 5892
```

### Endpoints
- `/`: Character studio 3D look preview.
- `/studio`: Full broadcast studio preview.
- `/api/health`: Health status probe.
- `/api/emotions`: Available emotions and expressions catalog.
- `/api/public-config`: Runtime public configuration.
