[English](it-admin-windows.md) | **日本語**

# IT 管理者ガイド: 管理された Windows PC

ドメイン参加または Intune で管理された Windows PC で `aiand` が何を実行するか、AppLocker、App Control for Business (WDAC)、PowerShell の制約付き言語モード (Constrained Language Mode)、Microsoft Defender、リダイレクトされたプロファイルや移動プロファイルがそれにどう影響するか、そして何を許可すればよいかをまとめます。ネットワーク接続、プロキシ、CA 証明書については[ネットワークとプロキシのガイド](it-admin-network.ja.md)を、Windows のキー保存の仕組みと、そのために実行する PowerShell のコマンドラインについては [Windows のキー保存](windows-key-storage.ja.md)を参照してください。

ユーザー側で管理者権限を必要とするものはありません。インストーラーが書き込むのは、ユーザープロファイルの下と、`HKCU\Environment` にあるユーザーの `Path` だけです。

## 何を、どこから実行するか

| 対象 | 場所 | 種類 | AppLocker の既定の規則 |
| --- | --- | --- | --- |
| Node.js 22 以降 | `%ProgramFiles%\nodejs\node.exe`(すべてのユーザー向けインストール) | 実行ファイル(OpenJS Foundation の署名付き) | 許可 |
| 1 ユーザー向けにインストールした Node.js(nvm-windows、ユーザー単位のインストーラー) | `%APPDATA%\nvm\…`、`%LOCALAPPDATA%\Programs\nodejs\…` | 実行ファイル | ブロック |
| aiand 本体 | `%USERPROFILE%\.aiand\cli\dist\*.js`(インストーラー)、または `npm prefix -g` 配下の `node_modules\@aiand\cli`(npm) | `node.exe` が読み込む JavaScript | 適用される規則なし |
| インストーラーのランチャー | `%USERPROFILE%\.local\bin\aiand.cmd` | バッチファイル | ブロック |
| npm のランチャー | `npm prefix -g`(既定は `%APPDATA%\npm`)の `aiand.cmd` と `aiand.ps1` | バッチファイル、スクリプト | ブロック |
| ビルド済みの aiand(PC に Node.js 22 以降がない場合のみ) | `%USERPROFILE%\.aiand\cli\aiand.exe`。事前に `%USERPROFILE%\.aiand\.cli-staging-*\aiand.exe` として確認 | 実行ファイル | ブロック |
| Windows のキー保存 (DPAPI) | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command …` | Windows | 許可 |
| 所有者のみのアクセス権、サインイン用ブラウザー | `System32` の `icacls.exe`、`whoami.exe`、`rundll32.exe url.dll,FileProtocolHandler`、`cmd.exe` | Windows | 許可 |
| インストーラー(制約付き言語モードでの PATH 更新) | `reg.exe query HKCU\Environment /v Path` | Windows | 許可 |
| インストーラー | `irm … \| iex`(ファイルなし)、または `update` と `uninstall` 用の `%USERPROFILE%\.aiand\cli\install.ps1` | PowerShell スクリプト | 制約付き言語モードで実行 |

aiand が `%TEMP%` から何かを実行することはありません。インストーラーは `%TEMP%` にダウンロードし、検証したファイルをプロファイルへ移してから実行します。

## AppLocker

既定の規則が許可するのは、`%WINDIR%` と `%PROGRAMFILES%` の下の実行ファイルとスクリプトだけです。この場合:

- Node.js は、すべてのユーザー向けに Program Files の下へインストールする必要があります。
- `aiand.cmd` ランチャーは拒否されます。インストーラーはそれを検出し、インストールを完了したうえで、ランチャーなしで aiand を実行するコマンドを表示します:
  `& 'C:\Program Files\nodejs\node.exe' '--disable-warning=ExperimentalWarning' '<プロファイル>\.aiand\cli\dist\index.js' <コマンド>`。
  `node.exe` は許可されており、`node.exe` が読み込む JavaScript ファイルに対する規則の種類は AppLocker にないため、追加の規則なしで動作します。
- ビルド済みの `aiand.exe` は拒否され、インストーラーはアプリケーション制御を名指しするメッセージを表示して停止します。代わりに Node.js をすべてのユーザー向けにインストールしてください。インストーラーは Node.js の経路を使うようになります。

ユーザーが `aiand` と入力して使えるようにするには、次のどちらかを選んでください:

1. **aiand をすべてのユーザー向けにインストールする。** 管理者として(SCCM、Intune の Win32 アプリ、または管理者として開いたコマンドプロンプトで)
   `npm install -g @aiand/cli@<version> --prefix "%ProgramFiles%\aiand"` を実行し、`%ProgramFiles%\aiand` をマシンの `Path` に追加します。ランチャーが Program Files の下に置かれるため、既定の規則で許可されます。ユーザーは更新できないので、新しいバージョンも同じ方法で配布してください。
2. **インストーラーのランチャーにパスの規則を追加する。** スクリプトの規則で、許可、Everyone、パス `%OSDRIVE%\Users\*\.local\bin\aiand.cmd`。このファイルはユーザーが書き込めるため、その名前で保存した任意のバッチファイルを実行できるようになります。`node.exe` を実行できるユーザーがすでにできること以上のことはバッチファイルにもできませんが、組織のポリシーと照らし合わせて判断してください。

バッチファイルには署名を付けられないため、発行元の規則で `aiand.cmd` を許可することはできません。リリースの `aiand.exe` はまだ署名されていません。検証済みのファイルに対して `Get-AppLockerFileInformation` で作ったハッシュの規則は使えますが、リリースごとに作り直す必要があります。

## App Control for Business (WDAC)

App Control が対象にするのは実行ファイル、DLL、PowerShell スクリプトで、バッチファイルは対象外のため、`aiand.cmd` は実行できます。`node.exe` は OpenJS Foundation の署名者(FilePublisher の規則)で許可するか、マネージドインストーラーで配布してください。ビルド済みの `aiand.exe` は、リリースが署名されるまではハッシュの規則が必要です。強制モードでは、PowerShell は署名のないスクリプトをすべて制約付き言語モードで実行します。インストーラーはこれに対応しています(次の節)。

## PowerShell

**制約付き言語モード。** AppLocker と App Control は、承認していないスクリプトと `irm … | iex` のワンライナーをこのモードで実行します。`__PSLockdownPolicy` でも同じです。インストーラーはこれを検出してその旨を表示し、コマンドレットだけでインストールします。変わる点:

- ユーザーの `Path` は `reg.exe` で読み取り、種類を保ったままレジストリプロバイダー経由で書き込みます。Windows に再読み込みを通知できないため、以前から開いているエクスプローラーから開いた新しいターミナルには反映されません。サインアウトして、もう一度サインインしてください。
- メッセージは stderr ではなくホストのストリームに出力されます。
- Windows のキー保存を使えません。aiand はキーを `%USERPROFILE%\.config\aiand\` 内の所有者のみが読めるファイルに保存し、その理由を `aiand status` に表示します。このファイルを保存時に暗号化するには `AIAND_SECRET_STORE_MASTER_KEY` を設定してください。ポリシーが適用される前に保存したキーは読み取れません。aiand がその旨を表示するので、`aiand login` を実行するとキーがファイルに保存し直されます。

**実行ポリシー。** `irm … | iex` は実行ポリシーの影響を受けません。`powershell -ExecutionPolicy Bypass -File …\install.ps1 update` は `Set-ExecutionPolicy` で設定したどのポリシーでも動作しますが、グループポリシー(`MachinePolicy` または `UserPolicy`)で設定したポリシーは `-ExecutionPolicy` より優先されます。グループポリシーで `AllSigned` が設定されている場合は、すべての操作で、ダウンロードしたスクリプトをテキストとして実行してください。更新はワンライナーのままで実行できます。引数を渡すには、テキストをスクリプトブロックで囲みます。この形式は制約付き言語モードでも動作します:

```powershell
iex "& { $(irm https://github.com/aiandlabs/aiand-cli/releases/latest/download/install.ps1) } uninstall"
```

引数は通常どおり PowerShell が解釈するため、空白を含む引数は引用符で囲んでください。パスを指定するインストーラーの設定(ローカルのリリースバンドル、ダウンロードのミラー)は、引数ではなくそれぞれ専用の環境変数で指定します。

`install.ps1` はまだ署名されていません。`RemoteSigned` の場合、インストーラーが保持するコピーはファイルとして実行できます。インストーラーがダウンロードしたものには Mark of the Web が付かないためです。ブラウザーで保存したコピーには付くため拒否されます。ワンライナーを使うか、そのファイルに `Unblock-File` を実行してください。

## Microsoft Defender と SmartScreen

- **SmartScreen** が確認するのは、Mark of the Web が付いたファイルをエクスプローラーから開いたときです。インストーラーのダウンロードには付かず、aiand はターミナルから起動するため、SmartScreen の対象になりません。
  **スマート アプリ コントロール**(Windows 11)はすべての実行ファイルを確認し、署名のないビルド済み `aiand.exe` をブロックします。Node.js の経路は影響を受けません。
- **ASR 規則「普及率、使用期間、または信頼できるリストの条件を満たさない限り、実行可能ファイルの実行をブロックする」**(`01443614-cd74-433a-b99e-2ecdc07bfc25`)は、新しい `aiand.exe` をブロックすることがあります。Node.js の経路を使うか、実行される 2 つのパスの両方を ASR 専用の除外に追加してください。1 つはインストーラーが有効化の前に確認するステージング用のコピー `%USERPROFILE%\.aiand\.cli-staging-*\aiand.exe`、もう 1 つはインストール先の `%USERPROFILE%\.aiand\cli\aiand.exe` です。後者だけを除外しても、インストールはブロックされたままです。
- **ASR 規則「難読化されている可能性のあるスクリプトの実行をブロックする」**(`5beb7efe-fd9a-4556-801d-275e5ffc04cc`)と AMSI は、`irm … | iex` とキー保存コマンドのスクリプト本文を検査します。どちらも難読化はしていません。検出された場合に許可すべきキー保存のコマンドラインは、[Windows のキー保存](windows-key-storage.ja.md)の AMSI の節にあります。

## 移動プロファイルとリダイレクトされたプロファイル

- aiand は `%APPDATA%` の下に何も置きません。設定とキーは `%USERPROFILE%\.config\aiand`(または `AIAND_CONFIG_DIR`)、インストーラーのコピーは `%USERPROFILE%\.aiand\cli` にあります。AppData をリダイレクトしてもこれらは移動しません。移動プロファイルでは、サインインとサインアウトのときにコピーされます。
- npm でのインストールは `%APPDATA%\npm` に置かれ、フォルダーのリダイレクトによってファイルサーバー(`\\server\share\…`)上に置かれます。Node.js はそこから実行できます。その場合、AppLocker のパスの規則には UNC パスを指定してください。
- **Windows のキー保存。** そのキーは `%APPDATA%\Microsoft\Protect` にあるため、リダイレクトされたプロファイルや移動プロファイルに追従し、ドメインアカウントならドメイン内のどの PC でもキーを読み取れます。ファイルサーバーに接続できず、オフライン ファイルにもそのキーがない場合はキーを読み取れません。aiand は警告を表示しますが何も削除しないため、サーバーに接続できるようになれば次の実行で読み取れます。管理者がパスワードをリセットしたローカルアカウントはこのキーを失うため、もう一度サインインしてください。
- **1 つの設定フォルダーを 2 台の PC から同時に使う場合**(共有上の `AIAND_CONFIG_DIR`、またはファイルサーバー上のホームフォルダー): aiand のロックには保持している PC がオペレーティングシステムのマシン ID(Windows フォルダーの `reg.exe` で読み取る `MachineGuid`)のハッシュで記録され、別の PC が保持しているロックは、更新され続けているかどうかだけで判断され、プロセス ID では判断されません。**フォルダーを共有するすべての PC を同時に更新してください。** 古い aiand は PC を記録せず、すべてのロックをプロセス ID で判断するため、新しい aiand が保持しているロックを奪うことがあります。更新後の最初の実行では、古い aiand が残したロックのために一度だけ最大 60 秒待つことがあります。
- **所有者のみのアクセス権** は `icacls` で設定するため、フォルダーのアクセス許可を変更する権利が必要です。フォルダーのリダイレクトでは既定でこの権利が与えられます。ない場合は、キーのファイルが所有者のみになっていないことを `aiand status` が表示します。
- **長いパス。** aiand 自身のパスは短く、260 文字を超えるパスは Node.js が自分で扱います。長い UNC パス上のリダイレクトされた `%APPDATA%\npm` に npm でインストールしたコーディングエージェントは制限を超えることがあります。*コンピューターの構成 > 管理用テンプレート > システム > ファイルシステム > Win32 の長いパスを有効にする* を有効にするか、`npm config set prefix` でより短いパスを設定してください。

## コーディングエージェント

各エージェントはそれぞれ独立したプログラムで、それぞれに規則が必要です。npm でインストールしたエージェントは、`npm prefix -g` の `.cmd` ランチャー(スクリプトの規則)から `node.exe` を経て起動し、さらにパッケージが `node_modules` の下に同梱する実行ファイルを使うことがあります。Claude Code のネイティブ版や omp のような単体のエージェントは `%USERPROFILE%\.local\bin` に置かれます(実行ファイルの規則)。ベンダーが署名している場合は、発行元で許可してください。

## ユーザーに表示されるメッセージ

| メッセージ | 原因 | 対処 |
| --- | --- | --- |
| `PowerShell runs in ConstrainedLanguage mode here …; installing with cmdlets only` | AppLocker、App Control、またはロックダウンのポリシー | 不要(情報の表示のみ) |
| `aiand <version> is installed, but its launcher … would not run` | AppLocker のスクリプトの規則が `aiand.cmd` を拒否している | 表示されたコマンドを使うか、[AppLocker](#applocker) を参照 |
| `Windows application control … would not start …aiand.exe` | ビルド済みの実行ファイルが拒否された | Node.js 22 以降をすべてのユーザー向けにインストールするか、そのファイルを許可する |
| `Windows application control … would not start …node.exe` | 1 ユーザー向けにインストールした Node.js | Node.js 22 以降をすべてのユーザー向けにインストールする |
| `Windows would not start <agent> (<path>)` | エージェントの実行ファイルが拒否された | そのエージェントを許可する([コーディングエージェント](#コーディングエージェント)) |
| `このプログラムはグループ ポリシーによってブロックされています …`(Windows が表示) | `.cmd` ランチャーが拒否された | ランチャーを許可するか、ランチャーが起動するプログラムを直接実行する |
| `PowerShell now runs in Constrained Language Mode here …` | サインイン後にポリシーが適用された | `aiand login` |
| `… は … デジタル署名されていません`(`File … cannot be loaded … not digitally signed`) | グループポリシーの `AllSigned` | [PowerShell](#powershell) のスクリプトブロックの形式 |

これらのケースは aiand の自動テストで確認しており、制約付き言語モードは PowerShell 7 で実行しています。各ポリシーをグループポリシーと Intune で適用したドメイン参加 PC での確認はまだです。見つかったことは [GitHub の issue](https://github.com/aiandlabs/aiand-cli/issues) で報告してください。
