[English](it-admin-certificates.md) | **日本語**

# 企業のルート証明書と HTTPS 検査

HTTPS を検査するネットワーク(ゲートウェイがすべてのサイトを企業のルート証明書で署名し直す環境)を管理する IT 管理者向けのページです。`aiand`、そのインストーラー、`aiand` が設定するコーディングエージェントがそのルート証明書を信頼するために必要なことを説明します。

要点: ほかの管理対象アプリケーションと同じように、ルート証明書をオペレーティングシステムの証明書ストアにインストールしてください。`aiand` 自体にはそれ以外の設定は不要で、環境変数を設定する必要もありません。

## ルート証明書の配置先

| プラットフォーム | ストア | 一般的な配布方法 |
| --- | --- | --- |
| Windows | ローカルコンピューターの **信頼されたルート証明機関**(Enterprise ストアとグループポリシーのストアも対象) | グループポリシー、Intune、または `certutil -addstore Root company-root.cer` |
| macOS | **システム** キーチェーン(SSL について「常に信頼」) | MDM の構成プロファイル、またはキーチェーンアクセスでシステムキーチェーンに読み込み、「この証明書を使用するとき」を「常に信頼」に設定 |
| Linux | ディストリビューションの CA バンドル | Debian/Ubuntu: `/usr/local/share/ca-certificates/` にコピーして `update-ca-certificates` を実行。RHEL/Fedora: `/etc/pki/ca-trust/source/anchors/` にコピーして `update-ca-trust` を実行 |

## `aiand` CLI

- CLI が送るすべてのリクエストは、Node.js に同梱されたルート証明書、オペレーティングシステムの証明書ストア、設定されていれば `NODE_EXTRA_CA_CERTS` の 3 つをあわせて信頼します。対象はサインイン(ブラウザとデバイスコード)、`models`、`status`、`aiand <agent> on`、chat と run、更新チェックです。
- これはプロキシの有無にかかわらず同じです。CLI は最初のリクエストの前に、Node.js 自身のシステムストア機能(`node --use-system-ca` が読むのと同じストア)を使ってストアを読み込みます。リリース版のバイナリは `--use-system-ca` 付きでビルドされています。
- Linux では、ストアはディストリビューションのバンドルファイルです。`/etc/ssl/certs/ca-certificates.crt`、`/etc/pki/tls/certs/ca-bundle.crt`、`/etc/ssl/ca-bundle.pem`、`/etc/pki/tls/cacert.pem`、`/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem`、`/etc/ssl/cert.pem` のうち、最初に存在するものを使います。`SSL_CERT_FILE` と `SSL_CERT_DIR` は読みません。これらはプロジェクトの環境(`.envrc` や開発コンテナー)から設定できるため、API キーを送るリクエストが信頼するルート証明書をそれらに決めさせないためです。ルート証明書はバンドルにインストールするか、`NODE_EXTRA_CA_CERTS` を使ってください。
- 要件: Node.js 22.21 以降(CLI の動作要件と同じ)。古い Node.js はストアを読めません。その場合は、企業のルート証明書を含む PEM ファイルを `NODE_EXTRA_CA_CERTS` に設定してください。
- `AIAND_SYSTEM_CA=0` を設定すると、ストアを使わず Node.js 自身のルート証明書だけを使います。そうしたい環境向けです。CLI がエージェントにストアを引き渡す動作(後述)も止まります。
- 証明書が原因でリクエストが失敗した場合、CLI はそのことをはっきり表示します: `Could not reach https://api.aiand.com: its certificate is not trusted on this computer.` と、その後に対処方法を表示します。`aiand status` は「Check your network and retry.」の代わりに同じ理由を表示し、`aiand status --json` は `auth.reason` にその理由を入れます。

## インストーラー

| 手順 | 使うもの | ストアを信頼するか |
| --- | --- | --- |
| `curl -fsSL …/install.sh \| bash` | お使いの `curl` | はい。`curl` の TLS ライブラリ経由(Linux ではバンドル、macOS ではキーチェーン) |
| `irm …/install.ps1 \| iex` | PowerShell | はい(Windows の証明書ストア) |
| リリース版バイナリのダウンロード(`install.sh`) | `curl` | はい(上と同じ) |
| リリース版バイナリのダウンロード(`install.ps1`) | .NET の `HttpWebRequest` | はい(Windows の証明書ストア) |
| npm パッケージのダウンロード(両インストーラー) | Node.js | Node.js 22.19 以降ではい。それより古い Node.js では `NODE_EXTRA_CA_CERTS` を設定 |

どの手順でも証明書で失敗した場合は `its certificate is not trusted on this computer` と表示し、既存のインストールは変更しません。

ソースからのビルド(`AIAND_SOURCE`)では `git clone` と `npm ci` を実行し、それぞれ独自の設定を使います。Windows では `git config --global http.sslBackend schannel` で Git が Windows のストアを使うようになります。npm には `NODE_EXTRA_CA_CERTS` を設定してください。

## コーディングエージェント

各エージェントは独自の HTTP クライアントを持ち、どのルート証明書を信頼するかを自分で決めます。ほとんどのエージェントは、すでにオペレーティングシステムのストアを読みます。

`aiand` がエージェントを起動するとき(`aiand <agent>`、`aiand run-agent <agent>`)や、エージェントをインストールするために `npm install -g` を実行するときは、そのプロセスにだけ最大 2 つの変数を追加します。マシンのほかの部分には何も追加しません。

- `NODE_USE_SYSTEM_CA=1`(Windows と macOS のみ): エージェントの Node.js(22.19 以降。エージェントのランタイムは `aiand` が必要とする Node.js より古いことがあります)や Bun(1.2.23 以降)がストアを読むようになります。Linux では `SSL_CERT_FILE` と `SSL_CERT_DIR` を読んでしまうため設定しません。
- `NODE_EXTRA_CA_CERTS`: aiand の設定フォルダー(既定では `~/.config/aiand/`、Windows では `%USERPROFILE%\.config\aiand\`)にある `system-ca.pem` を指します。Pi、Oh My Pi、Jouzu と `npm` にだけ設定し、自身でストアを読むエージェントにはファイルを作りません。このファイルには、ストアにあって Node.js 自身のルート証明書にないものが入っており、起動のたびにストアから書き直されます。そのようなルート証明書がストアにある場合にだけ設定します。`aiand logout --all` は、設定フォルダーのほかのファイルと一緒にこのファイルも削除します。

すでに設定されている変数はそのままにします。`SSL_CERT_FILE` は設定しません。Linux では、この変数は Codex のストアに追加されるのではなく、ストアを置き換えてしまうためです。これらの変数は、エージェントが実行するプロセスにも引き継がれます。

| エージェント | 自身でストアを読むか | `aiand` を使わずにエージェントを直接起動する場合 |
| --- | --- | --- |
| Claude Code | はい(`CLAUDE_CODE_CERT_STORE` の既定値は `bundled,system`。npm でインストールした場合は Node.js 22.15 以降が必要) | 設定不要。`NODE_EXTRA_CA_CERTS` で PEM ファイルを追加できます |
| Codex | はい(オペレーティングシステムのルート証明書) | 設定不要。`CODEX_CA_CERTIFICATE` で PEM ファイルを追加できます。Linux では、企業のルート証明書だけを含むファイルを `SSL_CERT_FILE` に指定しないでください。Codex がそのファイルだけを信頼するようになります |
| OpenCode | はい(`--use-system-ca` 付きでビルド) | 設定不要。`NODE_EXTRA_CA_CERTS` で PEM ファイルを追加できます |
| GitHub Copilot CLI | はい | 設定不要。`NODE_EXTRA_CA_CERTS` で PEM ファイルを追加できます |
| GitHub Copilot アプリ | はい | 設定不要(`aiand` はアプリを起動しません) |
| Hermes Agent | はい(Python の `truststore`) | 設定不要。`SSL_CERT_FILE` で PEM ファイルを追加できます。プロバイダーごとの `ssl_ca_cert` は、そのプロバイダーについてストアを置き換えます |
| Pi | いいえ(Node.js 自身のルート証明書のみ) | `NODE_USE_SYSTEM_CA=1`(Node.js 22.19 以降)を設定するか、企業のルート証明書を含む PEM ファイルを `NODE_EXTRA_CA_CERTS` に設定 |
| Oh My Pi | いいえ(Bun 自身のルート証明書のみ) | 企業のルート証明書を含む PEM ファイルを `NODE_EXTRA_CA_CERTS` に設定。Bun 1.2.23 以降では `NODE_USE_SYSTEM_CA=1` も使えます |
| Jouzu | いいえ(Node.js 自身のルート証明書のみ) | Pi と同じ |

Pi、Oh My Pi、Jouzu について、`aiand <agent> on` はゲートウェイの証明書をエージェント自身のルート証明書で確認し、その確認に失敗した場合(ネットワークが、ストアにしかないルート証明書で接続を署名し直している場合)にだけ、`NODE_USE_SYSTEM_CA=1` を挙げた注意を表示します。使われていない追加のルート証明書(Apple のものや MDM プロファイルのもの)では何も表示しません。プロキシ経由ではこの確認を直接行えないため、注意の先頭に「If your network inspects HTTPS」と付けて表示します。エージェントを直接起動する利用者がいる場合は、この変数をマシン全体に設定してください(Windows ではグループポリシーの環境変数、それ以外では `/etc/environment` やプロファイルスクリプト)。

この表は `aiand` がインストールするバージョンのエージェントについてのものです。それより新しいバージョンについては、各エージェントのドキュメントを参照してください。

## マシンの確認

- `aiand status` は、ゲートウェイに到達できることを報告するか、証明書が原因であることを表示します。
- `node -p "require('tls').getCACertificates('system').length"` は、Node.js がストアで見つけたルート証明書の数を表示します。企業のルート証明書を入れたマシンで 0 になる場合、そのルート証明書は Node.js が読むストアに入っていません(たとえば macOS で、信頼の設定がされていないままユーザーのログインキーチェーンに入っている場合)。

証明書のエラーを、検証を無効にして回避しないでください(`NODE_TLS_REJECT_UNAUTHORIZED=0`、`--insecure`、`ssl_verify: false`)。ネットワーク経路上の誰が出した証明書でも受け入れてしまいます。
