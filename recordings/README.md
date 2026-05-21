# recordings/

Drop `.cap` bundles here. Everything in this directory is gitignored except this README and `.gitkeep`.

Suggested layout:

```
recordings/
├── originals/        # untouched .cap bundles (your source of truth)
│   └── Demo.cap/
└── edited/           # working copies you've run scripts against
    └── Demo.cap/
```

Workflow:

```bash
# Make an editable copy so the original stays pristine.
cp -R recordings/originals/Demo.cap recordings/edited/Demo.cap

# Run scripts against the copy.
pnpm inspect recordings/edited/Demo.cap
pnpm suggest:cuts recordings/edited/Demo.cap --apply
pnpm suggest:zooms recordings/edited/Demo.cap --apply
```

If something goes wrong, every mutating script writes a `project-config.json.<timestamp>.bak` next to the live config inside the bundle — so you can also roll back without touching `originals/`.
