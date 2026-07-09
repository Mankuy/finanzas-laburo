# Finanzas Laburo — PWA offline

Ingresos (quién) + gastos (qué + familia) por mes. 100% offline tras instalar.

## URL (GitHub Pages)

Repo: https://github.com/Mankuy/finanzas-laburo  

**https://mankuy.github.io/finanzas-laburo/**

### Activar Pages (una vez)

1. https://github.com/Mankuy/finanzas-laburo/settings/pages  
2. Source → **Deploy from a branch** → `main` → `/ (root)`  
   *o* Source → **GitHub Actions** si preferís el workflow.  
3. Save. Esperá 1–2 min.

### Instalar en el celular

1. Abrí la URL HTTPS.  
2. Chrome: ⋮ → Instalar app · iPhone Safari: Compartir → Agregar a inicio.  
3. Abrí desde el **icono**. Modo avión para probar offline.

## Local

```bash
python3 -m http.server 8789 --bind 0.0.0.0
```

## Apps

| App | Puerto | Pages |
|-----|--------|-------|
| Control de Horas | 8788 | mankuy.github.io/control-horas |
| Finanzas Laburo | 8789 | mankuy.github.io/finanzas-laburo |
