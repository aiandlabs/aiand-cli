# リリースチャネル

[English](release-channels.md) | **日本語**

`@aiand/cli` には 2 つのチャネルがあります。どちらもこのリポジトリの `publish.yml` から npm の provenance 付きで公開され、インストーラーは同じ方法で両方を検証します。

| チャネル | npm の dist-tag | 内容 | バージョンの例 |
| --- | --- | --- | --- |
| stable | `latest` | リリース。タグ、変更履歴のセクション、GitHub のリリースがあります | `0.9.0` |
| next | `next` | CI を通過した `main` の最新ビルド | `0.9.1-next.20261128090503.g1a2b3c4` |

リリース前の修正を使いたい場合や、次に入る変更を試したい場合を除き、stable を使ってください。next のビルドはリリースと同じ CI を通過していますが、まだリリースとして選ばれておらず、専用の変更履歴のセクションもありません。

## next チャネルをインストールする

npm の場合:

```bash
npm install -g @aiand/cli@next
```

インストーラーの場合(macOS、Linux、Git Bash):

```bash
curl -fsSL https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.sh | bash -s -- --channel next
```

インストーラーの場合(Windows PowerShell):

```powershell
$env:AIAND_CHANNEL = 'next'; irm https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1 | iex
```

`AIAND_CHANNEL=next` は `install.sh` でも使えます。保存したスクリプトからは、どちらでもフラグを使えます(`install.sh --channel next`、`install.ps1 -Channel next` または `--channel next`)。

next チャネルには Node 22 以降が必要です。next 用のビルド済み実行ファイルはないため、Node がないマシンではインストーラーは何も変更せずに停止します。

## next のまま使う、または戻す

next のビルドをインストールすると、next のままになります。`install.sh update`(と `install.ps1 update`)は最新の next のビルドをインストールします。

リリースに戻すには:

```bash
bash ~/.aiand/cli/install.sh update --channel stable
```

```powershell
pwsh -ExecutionPolicy Bypass -File "$env:USERPROFILE\.aiand\cli\install.ps1" update -Channel stable
```

Windows PowerShell 5.1 では、`pwsh` の代わりに `powershell` を使ってください。

next のビルドは、その前のリリースより新しいバージョンです。そのため、次のリリースが出るまでは戻すことがダウングレードになり、インストーラーは拒否します。リリースを待つか、`AIAND_VERSION=x.y.z` でリリースを指定してください。そのシェルに `AIAND_CHANNEL=next` が残っている場合は、それを消すか `--channel stable` も付けてください。インストーラーは next と `AIAND_VERSION` の組み合わせを拒否します。npm の場合は `npm install -g @aiand/cli@latest` です。

## next のビルドの検証方法

インストーラーは、GitHub の `next` プレリリースから `SHA256SUMS`(`releases/download/next/SHA256SUMS`)を読みます。このファイルは tarball を 1 つ、つまりバージョンを 1 つだけ示します。インストーラーはそのバージョンを npm からダウンロードし、npm の sha512 とこのファイルの sha256 の両方に一致した場合にだけインストールします。リリースも同じ 2 つの検証を受けます。[ADR 1](adr/0001-installers-verify-npm-release.md) を参照してください。また、`next` プレリリースが next のビルド以外を示している場合も拒否します。

`next` プレリリースは、常に npm が `next` と呼ぶビルドを示します。プレリリースなので、`releases/latest` がこれを指すことはありません。

## バージョン

next のバージョンは `<次のパッチ>-next.<コミット時刻>.g<短いコミット ID>` です。時刻はコミットの UTC 時刻(`YYYYMMDDHHmmss`)です。そのため next のバージョンは:

- 直前のリリースより上、次のリリースより下に並びます。
- ビルド元のコミットがわかります。
- 同じコミットからは毎回同じバージョンになるため、再実行で二重に公開されることはありません。

リポジトリの `package.json` はリリース済みのバージョンのままです。ビルドは、パックするコピーにだけ next のバージョンを設定します。

## 古いメジャーバージョンの修正

`main` が新しいメジャーバージョンに進んだあと、前のメジャーバージョンへの修正は `release/<major>.x` ブランチ(例: `release/1.x`)に入り、そこからリリースされます。`latest` がすでに新しいメジャーバージョンの場合、そのリリースは npm で `latest-<major>`(例: `latest-1`)として公開されます。そのため `npm install @aiand/cli` が古いバージョンに戻ることはありません。

`backport-1.x` ラベルの付いた `main` へのプルリクエストは、マージされると `release/1.x` にコピーされます。ボットが変更を cherry-pick したプルリクエストを作成します。変更がそのまま適用できない場合は、手作業で行う手順を元のプルリクエストにコメントします。
