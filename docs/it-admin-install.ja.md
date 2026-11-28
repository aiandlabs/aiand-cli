# IT 管理者向けインストールガイド

[English](it-admin-install.md) | **日本語**

このガイドは、ユーザーに管理者権限がなく、GitHub や `registry.npmjs.org` に接続できない可能性があるマシン向けです。接続できるのは社内の npm レジストリ(Artifactory、Nexus、Verdaccio)、社内のダウンロードミラー、またはファイル共有だけ、という環境を想定しています。対象は `install.sh`(macOS、Linux、Git Bash)と `install.ps1`(Windows PowerShell 5.1 と PowerShell 7)です。インストール後の CLI 自身の通信については、[IT 管理者向けネットワーク・プロキシガイド](it-admin-network.ja.md)を参照してください。

## 管理者権限は不要

インストーラーはユーザーのホームディレクトリにだけ書き込み、権限の昇格を求めることはありません。

| 対象 | macOS と Linux | Windows |
| --- | --- | --- |
| CLI 本体 | `~/.aiand/cli` | `%USERPROFILE%\.aiand\cli` |
| `aiand` ランチャー | `~/.local/bin/aiand` | `%USERPROFILE%\.local\bin\aiand.cmd` |
| PATH | ユーザーのシェル rc ファイルに 1 行追加 | ユーザーの `Path`(HKCU)。マシン全体の `Path` は変更しません |
| プロファイルとサインイン情報 | `~/.config/aiand` | `%USERPROFILE%\.config\aiand` |

`AIAND_DIR` で CLI の場所を変更できます。PATH を IT が管理しているマシンでは、`AIAND_NO_MODIFY_PATH=1` を設定すると PATH を変更しません。

インストール経路は 2 つあり、自動で選ばれます。

- **PATH 上に Node.js 22 以降がある場合**: リリースの npm tarball を展開し、その Node で実行します。
- **適切な Node がない場合**: そのプラットフォーム向けのリリースのビルド済み実行ファイル(`aiand-win32-x64.exe`、`aiand-darwin-arm64` など)を使います。Node は一切不要です。アプリケーション制御(AppLocker、WDAC)でユーザープロファイル配下の実行ファイルがブロックされる場合は、`%USERPROFILE%\.aiand\cli\aiand.exe` を許可するか、許可された場所に Node 22 以降をインストールして Node の経路を使ってください。

## 既定で接続する先

| オリジン | 用途 |
| --- | --- |
| `https://github.com/aiandlabs/aiand-cli/releases`(およびダウンロードのリダイレクト先の `*.githubusercontent.com` のホスト) | `SHA256SUMS`、インストーラースクリプト、ビルド済み実行ファイル |
| `https://registry.npmjs.org` | npm tarball(Node の経路のみ) |

インストールは、既存のものを置き換える前に必ず検証されます。npm tarball は npm の sha512 とリリースの `SHA256SUMS` にある sha256 の両方に一致する必要があり、ビルド済み実行ファイルは `SHA256SUMS` に一致し、想定どおりのバージョンを報告する必要があります。検証に失敗した場合、既存のインストールはそのまま残ります。

これらのオリジンがブロックされている場合は、社内ミラーかオフラインバンドルを使います。

> **`--sums-sha256` でリリースを固定してください。** ミラーやバンドルは自身の `SHA256SUMS` を持っており、インストーラーはすべてのファイルをその `SHA256SUMS` と照合します。そのため、照合だけではファイル同士が一致していることしか証明できず、本物のリリースであることは証明できません。ミラーやバンドルを GitHub で公開されたリリースに結び付けるのは `--sums-sha256 <hex>` です。ミラーやバンドルからインストールするときは、必ず指定してください。[リリースの固定](#リリースの固定)を参照してください。

## 方法 1: 社内ミラー

### npm レジストリ

インストーラーは npm の設定にあるレジストリ、つまり `npm install` と同じレジストリを使います。これは `npm config get registry` の値で、`NPM_CONFIG_REGISTRY`、`npm_config_registry`、ユーザーの `.npmrc`、グローバルの `npmrc` から読み取られます。`@aiand` スコープのレジストリ(`@aiand:registry=…`)が設定されていれば、そちらが優先されます。そのレジストリが `registry.npmjs.org` でない場合は npm 自身が tarball を取得するため、npm の設定にある認証情報、プロキシ、CA の設定がそのまま適用されます。

```bash
npm config set registry https://artifactory.example.com/api/npm/npm-remote/
```

レジストリは `@aiand/cli` を提供している必要があります(`registry.npmjs.org` のリモートリポジトリやプロキシリポジトリであれば提供されます)。レジストリから取得できない場合、インストールは停止します。公開レジストリに切り替えることはありません。

### ダウンロードミラー

`SHA256SUMS` とビルド済み実行ファイルは npm ではなく GitHub のリリースから取得します。`https://github.com/aiandlabs/aiand-cli/releases` を同じ構成でミラーしてください(Artifactory や Nexus の汎用リモートリポジトリ、または任意の Web サーバー)。

```text
<base>/latest/download/SHA256SUMS
<base>/download/v<version>/SHA256SUMS
<base>/download/v<version>/<file>
```

そのうえで、`--mirror <base>` でインストーラーにミラーを指定します。ベース URL は `https://` で始まり、ユーザー名、パスワード、クエリ、フラグメントを含まず、サインインなしで読み取れる必要があります。ミラーが `latest` を提供できない場合は、インストールするリリースを `AIAND_VERSION` でも指定してください。

ミラーはコマンドラインか、後述の管理ポリシーからのみ指定できます。環境変数でミラーが変わることはないため、ディレクトリの `.envrc` や意図しないシェルプロファイルによって別のサーバーに誘導されることはありません。npm レジストリは意図的に扱いが異なり、`npm install` と同じく npm の設定に従います。それでもインストール内容は変わりません。どのレジストリから取得した tarball も、リリースの `SHA256SUMS` にある sha256 と一致する必要があるためです。

macOS と Linux:

```bash
bash install.sh --mirror https://artifactory.example.com/artifactory/github-aiand-cli/releases
```

Windows: `irm … | iex` は引数を受け取らないため、スクリプトをダウンロードしてファイルとして実行します。

```powershell
$base = 'https://artifactory.example.com/artifactory/github-aiand-cli/releases'
irm "$base/latest/download/install.ps1" -OutFile "$env:TEMP\install.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\install.ps1" --mirror $base
```

ミラーから取得できない場合、インストールは停止します。GitHub に切り替えることはありません。

ユーザーのホームにあるファイルはユーザーが実行するどのプログラムからも変更できるため、インストールはミラーの記録を残しません。そのため、`update` でも `--mirror` を指定する必要があります。

```bash
bash ~/.aiand/cli/install.sh update --mirror https://artifactory.example.com/artifactory/github-aiand-cli/releases
```

指定しない場合、`update` は GitHub に接続し、GitHub に接続できなければ `--mirror` を案内するメッセージを表示して停止します。フラグなしですべてのユーザーの既定のミラーにするには、`downloadMirror` 管理ポリシーを設定してください。

### `downloadMirror` 管理ポリシー

CLI の管理ポリシーは管理者だけが書き込める場所にあり、インストーラーは同じ場所から `downloadMirror` を読み取ります。

| OS | 場所 | 値 |
| --- | --- | --- |
| Windows | `HKLM\Software\Policies\aiand\cli`(または `HKCU\Software\Policies\aiand\cli`。マシンのキーが優先)、グループポリシーまたは Intune | `downloadMirror`(`REG_SZ`) |
| macOS | `/Library/Managed Preferences/com.aiand.cli.plist`、MDM から配布する `com.aiand.cli` の構成プロファイル | `downloadMirror`(文字列) |
| Linux | `/etc/aiand/policy.json`(root が所有する通常ファイル) | `{"downloadMirror": "https://…"}` |

```powershell
# Windows で管理者として実行(またはグループポリシーで同じ値を設定)
New-Item -Path 'HKLM:\Software\Policies\aiand\cli' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\Software\Policies\aiand\cli' -Name downloadMirror -Value 'https://artifactory.example.com/artifactory/github-aiand-cli/releases'
```

ポリシーを設定すると、インストールと更新はフラグなしでそのミラーを使います。別の URL を指定した `--mirror` は拒否されます。root が所有する通常ファイルではないポリシーファイルは、無視されるのではなく拒否されます。`--from` によるバンドルのインストールは引き続き使えます。

この場合も 2 つの検証はどちらも行われます。社内レジストリから取得した tarball は、そのレジストリが示す sha512 と、ミラーした `SHA256SUMS` の sha256 の両方に一致する必要があります。ミラーは元のファイルを正しく複製しているものとして扱われます。インストールを特定の既知のリリースに結び付けるには、その `SHA256SUMS` を固定してください([リリースの固定](#リリースの固定)を参照)。

## 方法 2: オフラインバンドル

このバージョン以降の各リリースでは、プラットフォームごとに 1 つのアーカイブと、それらのチェックサムファイルを公開します。

| アセット | 対象 |
| --- | --- |
| `aiand-offline-<version>-win32-x64.zip` | Windows x64 |
| `aiand-offline-<version>-darwin-arm64.tar.gz` | macOS(Apple シリコン) |
| `aiand-offline-<version>-darwin-x64.tar.gz` | macOS(Intel) |
| `aiand-offline-<version>-linux-x64.tar.gz` | Linux x64 |
| `aiand-offline-<version>-linux-arm64.tar.gz` | Linux arm64 |
| `SHA256SUMS.offline` | 各アーカイブの sha256 |

各アーカイブには `aiand-offline-<version>-<platform>` というディレクトリが 1 つあり、その中にリリースの `SHA256SUMS`、npm tarball、`install.sh`、`install.ps1`、そしてリリースが公開している場合はそのプラットフォームのビルド済み実行ファイルが入っています。ビルド済み実行ファイルを含まないバンドルでも、PATH 上に Node 22 以降があればどこでもインストールできます。

### 共有フォルダーの準備(リリースごとに 1 回)

GitHub に接続できるマシンで、リリースページから必要なアーカイブと `SHA256SUMS.offline`、`SHA256SUMS` をダウンロードし、検証します。

```bash
sha256sum --check --ignore-missing SHA256SUMS.offline
sha256sum SHA256SUMS   # この値を --sums-sha256 に使います
```

```powershell
Get-FileHash .\aiand-offline-<version>-win32-x64.zip -Algorithm SHA256   # SHA256SUMS.offline と比較します
Get-FileHash .\SHA256SUMS -Algorithm SHA256                              # この値を --sums-sha256 に使います
```

アーカイブを、ユーザーが読み取りはできても書き込みはできない共有フォルダーにコピーします。Windows 向けには、ユーザーが中の `install.ps1` を実行できるよう、`.zip` をそこで展開しておいてください。

### 共有フォルダーからのインストール

`--from` には、アーカイブか、展開したディレクトリを指定します。何もダウンロードせず、使用するすべてのファイルを、何かを置き換える前にバンドルの `SHA256SUMS` と照合します。

macOS と Linux:

```bash
tar -xzf /mnt/share/aiand/aiand-offline-<version>-linux-x64.tar.gz -C /tmp
bash /tmp/aiand-offline-<version>-linux-x64/install.sh \
  --from /mnt/share/aiand/aiand-offline-<version>-linux-x64.tar.gz \
  --sums-sha256 <SHA256SUMS の sha256>
```

Windows:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File \\fileserver\aiand\aiand-offline-<version>-win32-x64\install.ps1 `
  --from \\fileserver\aiand\aiand-offline-<version>-win32-x64 `
  --sums-sha256 <SHA256SUMS の sha256>
```

`-ExecutionPolicy Bypass` はそのプロセスだけに適用され、マシンのポリシーは変更しません。

更新するには、インストール済みのスクリプトを次のリリースのバンドルに対して実行します。

```bash
bash ~/.aiand/cli/install.sh update --from /mnt/share/aiand/aiand-offline-<next>-linux-x64.tar.gz
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update --from \\fileserver\aiand\aiand-offline-<next>-win32-x64
```

## リリースの固定

固定しない場合、ミラーやバンドルはそのまま信頼されます。照合に使う `SHA256SUMS` もミラーやバンドル自身が提供するため、ミラーや共有フォルダーを変更できる人は、照合を通したままインストール内容を変えられます。それを本物のリリースに結び付ける唯一の手段が `--sums-sha256 <hex>` です。読み取った `SHA256SUMS` の sha256 がこの値と完全に一致しない限り、インストールは停止します。

値は、上記のとおり GitHub のリリースページにある `SHA256SUMS` から取得してください。1 つのリリースのバンドルはどのプラットフォームでも同じ `SHA256SUMS` を持つため、1 つの値ですべてに対応できます。`AIAND_SUMS_SHA256` を使うと環境変数から同じ固定を設定できます。この変数はインストールを停止させることしかできず、ファイルの取得元を変えることはありません。

## インストール後

- **更新通知。** 対話型ターミナルでは、CLI が 1 日 1 回 `registry.npmjs.org` で新しいバージョンを確認します。オフラインでは確認が静かに失敗します。`AIAND_UPDATE_CHECK=0` を設定すると確認を行いません。
- **サインインと利用。** `aiand login` とコーディングエージェントには ai& の gateway への接続が必要です。[ネットワーク・プロキシガイド](it-admin-network.ja.md)を参照してください。
- **コーディングエージェント。** エージェントがインストールされていない場合、`aiand <agent>` はそのエージェント用の正確な `npm install -g <package>@<version>` コマンドを実行するか確認し、実行しない場合は IT が実行できるようそのコマンドを表示します。npm は npm の設定にあるレジストリからインストールするため、そこに設定した社内レジストリが使われます。macOS と Linux で管理者権限がない場合、npm のグローバルインストールには、先にユーザーが所有するフォルダーを指定する必要があります。`npm config set prefix "$HOME/.local"` を実行すると、エージェントは `aiand` と同じ `~/.local/bin` に入ります。Windows では npm の既定のグローバルフォルダーがもともとユーザーごとです。

## リファレンス

| フラグ | 環境変数 | 意味 |
| --- | --- | --- |
| `--from <path>` | | オフラインバンドル(アーカイブまたはディレクトリ)からインストール |
| `--mirror <url>` | | この https ミラーからリリースファイルをダウンロード(`update` でも指定) |
| | `downloadMirror`(管理ポリシー) | 管理者が設定する、すべてのインストールと更新のミラー |
| `--sums-sha256 <hex>` | `AIAND_SUMS_SHA256` | 読み取る `SHA256SUMS` の sha256 がこの値であること |
| | `AIAND_VERSION` | 最新ではなくこのリリースをインストール |
| | `NPM_CONFIG_REGISTRY` | npm のレジストリ(または `npm config set registry`) |

フラグは対応する環境変数より優先されます。`--from` と `--mirror` は同時に指定できません。
