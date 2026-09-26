# Secrets Saver para Orca

Arquivos de configuração dos seus projetos e um cofre pessoal na barra lateral do Orca.

> **Modificação não oficial do Orca.** Este projeto substitui o `app.asar` instalado para habilitar a comunicação entre o painel e o worker. Não é um plugin independente para publicar no catálogo do Orca e não tem vínculo com sua equipe. A instalação cria um backup; atualizações do Orca podem remover o patch ou torná-lo incompatível. O pacote distribui nosso código e scripts, sem incluir binários do Orca.

## O que aparece no painel

- **Local:** lista arquivos reconhecidos pelo nome, como `.env`, `.env.production` e configurações convencionais, nos projetos abertos no Orca. Permite consultar, copiar e editar o conteúdo. Salvar altera o arquivo real do projeto.
- **Vaulted:** lista pessoal de secrets, independente dos repositórios, sem seletor de projeto. Permite adicionar, revelar, editar, copiar e apagar. Usa o armazenamento criptografado do Orca e o chaveiro do sistema operacional.

O plugin precisa de confiança: seu worker lê arquivos locais e usa APIs internas do Orca. Ele não fornece sincronização em nuvem nem uma senha mestra própria.

## Requisitos

- **Linux**, com Orca instalado. Integração desenvolvida sobre Orca **1.4.205**; outras versões dependem de compatibilidade dos arquivos internos.
- **Node.js 22.12 ou superior**, npm, Bash e acesso a `sudo` para substituir o arquivo da instalação.
- Um chaveiro compatível com Secret Service, como GNOME Keyring, ativo e desbloqueado na sessão gráfica.
- Internet para instalar as dependências npm. macOS e Windows ainda não têm instalador neste projeto.

## Instalar

1. Baixe o [pacote da release v0.1.0](https://github.com/Christopher-Moreira/orca-secrets-saver/releases/download/v0.1.0/secrets-saver-0.1.0.tar.gz) e extraia-o. Também é possível usar **Code → Download ZIP** no [repositório](https://github.com/Christopher-Moreira/orca-secrets-saver) ou clonar:

   ```bash
   git clone https://github.com/Christopher-Moreira/orca-secrets-saver.git
   cd orca-secrets-saver
   ```
2. Salve seu trabalho e feche o Orca. Abra um terminal externo na pasta extraída.
3. Execute **sem sudo**:

   ```bash
   bash install.sh
   ```

O instalador prepara o plugin e deriva o patch da sua instalação atual. Somente a etapa de aplicação solicita sudo. Ele verifica os arquivos antes de substituir o `app.asar`, preserva um backup e configura o atalho do usuário para iniciar com `--password-store=gnome-libsecret`.

4. Abra o Orca. Em **Settings → Plugins**, habilite plugins em modo de desenvolvimento, adicione o caminho absoluto mostrado pelo instalador (`orca-plugin/dist`) e aprove as permissões do **Secrets Saver**: `secrets`, `storage` e `workspace:read`.
5. Abra **Secrets** na barra lateral. Mantenha a pasta instalada no mesmo lugar: o Orca carrega o plugin dali.

Para outra localização do Orca:

```bash
ORCA_RES=/caminho/do/orca/resources bash install.sh
```

Para preparar os arquivos sem modificar a instalação:

```bash
bash install.sh --prepare
```

## Idioma

Em `orca-plugin/settings.json`, a flag `followOrcaLanguage` vem ativada:

```json
{
  "followOrcaLanguage": true,
  "language": "en"
}
```

O painel segue `settings.uiLanguage` do Orca. Quando o Orca usa `system`, segue o idioma informado pelo ambiente do sistema. Há traduções do painel em português, inglês e espanhol; outros idiomas usam inglês. As abas **Local** e **Vaulted** mantêm seus nomes. Alguns diagnósticos técnicos do worker ainda aparecem em português.

Para fixar um idioma, defina `followOrcaLanguage` como `false` e `language` como `pt`, `en` ou `es`. Depois execute:

```bash
npm run build --prefix orca-plugin
```

Recarregue o plugin ou reinicie o Orca. Uma mudança de idioma não exige reaplicar o patch.

## Atualizar e desinstalar

Depois de atualizar o Orca, feche-o e execute `bash install.sh` novamente. O instalador usa a versão instalada, sem reutilizar um arquivo antigo como fonte do patch. Se as posições esperadas do código interno mudaram, a preparação aborta e a instalação fica intacta.

Para restaurar o `app.asar` original, feche o Orca e execute:

```bash
bash install.sh --uninstall
```

Em seguida, remova o caminho de desenvolvimento do plugin em Settings → Plugins. O cofre e os arquivos locais são preservados. O atalho com libsecret também permanece, para manter acesso ao mesmo chaveiro. Se existia um atalho personalizado, seu backup fica em `~/.local/share/applications/stably-orca.desktop.secrets-saver-bak`.

A restauração recusa um backup se o Orca tiver sido atualizado desde a aplicação. Instalações antigas sem metadados de recuperação precisam ser reaplicadas pelo instalador novo antes de usar esta desinstalação.

## Criar o pacote para distribuir

```bash
npm ci --prefix orca-plugin
node scripts/package.mjs
```

Os arquivos `release/secrets-saver-0.1.0.tar.gz` e `.tar.gz.sha256` podem ser anexados a uma release do GitHub. O pacote inclui o plugin compilado, fontes e instalador. Não inclui `app.asar`, backups, perfis, secrets ou `node_modules`. No diretório do download, confira a integridade com:

```bash
sha256sum -c secrets-saver-0.1.0.tar.gz.sha256
```

## Problemas comuns

- **`action: not a panel-callable action`:** o patch está ausente. Feche o Orca e execute o instalador novamente.
- **Criptografia indisponível:** desbloqueie o chaveiro da sessão gráfica e abra o Orca pelo atalho configurado ou com `stably-orca --password-store=gnome-libsecret`.
- **Local vazio:** abra um projeto no Orca. A descoberta depende do estado interno dos perfis, dos nomes aceitos e dos limites de varredura do scanner; não exibe qualquer arquivo arbitrário.
- **Âncora ausente/ambígua:** essa versão do Orca precisa de adaptação do patch. Não aplique manualmente um arquivo preparado para outra versão.

Detalhes da integração estão em [install/README.md](install/README.md).
