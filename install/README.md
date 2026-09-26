# Integração local com o Orca

Consulte o [README principal](../README.md) para instalar, configurar o idioma e desinstalar.

O patch acrescenta `worker.invoke` às verificações de ações do painel e encaminha a chamada ao comando do worker do próprio plugin. Não altera os schemas de `secrets.get`/`secrets.set`.

## Preparação manual

```bash
npm ci --prefix orca-plugin
npm ci --prefix install
npm run build --prefix orca-plugin
bash install/build-patched-asar.sh
# Feche o Orca antes desta etapa:
sudo bash install/apply.sh
```

`ORCA_RES` seleciona o diretório de resources (padrão `/opt/stably-orca/resources`). Use o mesmo valor na preparação e aplicação. Com Node instalado por gerenciador de versões, prefira o `install.sh` principal, que encaminha seu PATH ao sudo.

O build usa o arquivo instalado como fonte, verifica as âncoras e compara a lista completa de arquivos. `install/build/metadata.json` registra hashes da fonte e do resultado. A aplicação recusa arquivos alterados desde o build e substitui o destino por renomeação atômica. O backup é `app.asar.orca-secrets-bak`; backups anteriores são preservados com sufixo de data quando uma nova versão original é instalada.

Para restauração, `app.asar.orca-secrets-state.json` associa o backup ao patch aplicado. O instalador recusa a restauração se o arquivo instalado tiver mudado após a aplicação.

Nunca distribua `install/build`, arquivos `app.asar*`, dumps dos bundles do Orca ou dados de perfis. Use `node scripts/package.mjs`, que empacota apenas uma lista explícita dos arquivos do projeto.
