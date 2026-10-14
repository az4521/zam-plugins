# Zam plugins

Zam's official plugin repo. Zam reads it straight from GitHub at a pinned
commit, so what's published here is what users run.

## Layout

    index.json            the plugins on offer (schema 1)
    plugins/<id>/         each published plugin: manifest.json (every file with
                          its size and SHA-256), the entry bundle, its files
    src/<name>/           source of the plugins built here (src/dpdfnet:
                          com.zam.dpdfnet)
    zam-api/              Zam's plugin API (TypeScript declarations, and the
                          Java interfaces Android native hosts implement),
                          copied from Zam by scripts/sync-zam-api.mjs

## Working on a plugin

    npm install
    npm run check         type-check against zam-api/
    npm test
    npm run build:dpdfnet writes plugins/com.zam.dpdfnet and its index.json entry

Bump the plugin's version in its build script, build, commit the source and
the output together, and push. When Zam's plugin API changes, refresh
zam-api/ from a Zam checkout:

    npm run sync-api -- ../vue_matrix_client

A plugin's `minAppVersion` is the first Zam with every API it uses.
