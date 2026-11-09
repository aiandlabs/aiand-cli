[English](windows-key-storage.md) | **日本語**

# Windows でのキーの保存: コスト、リスク、テスト計画

Windows の DPAPI 方式がどのように動くかは、`CONTEXT.md`(Storage tier)と README([API キーの保存場所](../README.ja.md#api-キーの保存場所))にあります。このメモは、実際の多数のマシンに展開して運用する方に向けたものです。

## 読み取りのコスト

DPAPI へは、Windows PowerShell 5.1(`powershell.exe -NoProfile -NonInteractive -Command ...`。シークレットは標準入力だけで渡します)経由でアクセスします。ネイティブモジュールはありません。そのため、次のようになります。

- **コールドスタート時の読み取り**(キーが必要な、新しく起動した `aiand` プロセス)のたびに、PowerShell が 1 回起動します。**書き込み**のたびにも 1 回起動します。Windows PowerShell 5.1 は Node ではなく .NET Framework です。起動直後のマシンや、プロセスの起動をスキャンするエンドポイントセキュリティが動いているマシンでは、この起動に 1 秒以上かかることがあります(`DPAPI_TIMEOUT_MS` は 20 秒まで許容します)。
- 同じプロセスの中では、平文がキャッシュされます(`src/secrets.ts` の `dpapiPlaintext`)。保存のあとに読み取る場合や、何度も読み取る場合でも、PowerShell は 1 回しか起動しません。`test/secrets-windows.test.mjs` がこれを検証しています("what a DPAPI read costs")。
- Codex は、**セッションごとに** `aiand key export` を認証コマンドとして実行します。それぞれが新しいプロセスなので、毎回 1 回のコールドスタート時の読み取りのコストがかかります。注意すべきコストはこれです。
- キャッシュはメモリ上だけです。このコストを隠すために、**ディスク上の平文キャッシュを追加しないでください。** 追加すると、ファイルのアクセス権だけでキーを守ることになり、これは DPAPI 方式が避けようとしているものです。設定フォルダー内のどのファイルにもキーが含まれていないことを、テストで検証しています。
- DPAPI への移行が一時的な理由(制約付き言語モード (Constrained Language Mode) 以外)で失敗したファイル形式のキーは、動作するか、ユーザーが `AIAND_KEY_STORAGE=file` を設定するまで、プロセスごとに次の読み取りで再試行されます。`credentials.json` に記録されるのは制約付き言語モードだけです(`storage_fallback: "clm"`)。ポリシーによるものはこれだけだからです。

## エンドポイントセキュリティと AMSI

`-Command` のテキストは `[System.Security.Cryptography.ProtectedData]` を名指しして `Unprotect` を呼び出し、標準入力で base64 を受け取ります。この形は認証情報を盗むツールに似ているため、Microsoft Defender、サードパーティの EDR、AMSI が検知またはブロックすることがあります。ブロックされると、aiand から見ると通常の PowerShell の失敗と同じ `unavailable` になります。警告が表示され、キーは所有者のみが読めるファイルに保存され、DPAPI は次の保存時にもう一度試されます。

行わないこと: スクリプトを難読化したり、型名を断片から組み立てたりして、スキャナーをすり抜けることはしません。検知は、ユーザーのセキュリティチームが確認すべきシグナルであり、許可リストへの登録はチームが判断することです。

用意されている対策:

- `AIAND_KEY_STORAGE=file` は、DPAPI と PowerShell をまったく使いません(`AIAND_SECRET_STORE_MASTER_KEY` を指定すると、フォルダーのコピーに対してファイルが暗号化されます)。フォールバックの警告にもこの変数が示されます。
- コマンドラインは固定で、識別できます。常に `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -Command <dpapiScript>` であり、`-ExecutionPolicy Bypass` や `-EncodedCommand` は使わず、シークレットは argv にも環境変数にも含まれません。セキュリティチームは、これを基準に許可リストへ登録できます。

## 実際の Windows マシンでのテスト計画

上記はすべて、macOS と Linux でスタブを使ってテストしています。ユニットテストでは、Defender、AMSI、実際の DPAPI のタイミングは確認できません。この方式を変更するリリースの前に、Windows 11 で、Defender のリアルタイム保護をオン、クラウド保護を既定の設定にして、次を実施してください。

1. `npm ci && npm run build && node scripts/windows-secrets-smoke.mjs`: 実際の DPAPI でのラウンドトリップ、ACL、制約付き言語モードへのフォールバックを確認します。`installer-windows` の CI ジョブは、Defender が有効な `windows-latest` でこれを実行するため、そこで検知されるとジョブが失敗します。
2. `aiand login` を実行し、`aiand status` を実行します。`storage  Windows DPAPI` と表示されることを確認します。Defender の通知がなく、保護の履歴にも何も記録されていないことを確認します。
3. コールドスタート時の読み取りの時間を計測します: `Measure-Command { aiand key export }` を、再起動の直後と、ウォーム状態の両方で、それぞれ 3 回実行し、どちらも記録します。`AIAND_KEY_STORAGE=file` と比較します。
4. `aiand key export` のプロセスを 10 個同時に実行します(`1..10 | ForEach-Object -Parallel { aiand key export }`)。すべて成功し、`credentials.json` と両方のキーストアが壊れていないことを確認します。
5. Defender の Controlled folder access、Attack surface reduction ルール(LSASS からの認証情報の窃取をブロック、PSExec/WMI からのプロセス作成をブロック、難読化されたスクリプトをブロック)、Tamper protection をオンにして、手順 2 と 3 を繰り返します。aiand を親とする `powershell.exe` に対する ASR の監査イベントは、すべてレポートに含めてください。
6. Defender の Advanced Hunting またはイベントビューアー(Microsoft-Windows-Windows Defender/Operational、AMSI のイベント)で、`ProtectedData` を名指しした検知がないことを確認します。
7. わざとブロックします: `node.exe` から起動された `powershell.exe` をブロックする Defender のカスタムインジケーターを追加するか、`__PSLockdownPolicy=4` をマシン全体に設定します(`setx /M __PSLockdownPolicy 4` を実行して、新しいセッションを開きます)。プロセス単位の値は Server 2022 の Windows PowerShell には効かないため、スモークスクリプトはそこでロックダウンの確認を省略します。1 行の警告が表示され、キーが所有者のみが読めるファイルに保存され、`aiand status` が `file (owner-only, ...)` と表示されることを確認します。ロックダウンの場合は、制約付き言語モードの注記も表示されます。ブロックを解除して `aiand login` を実行すると、キーが DPAPI に戻ります。
8. 共有フォルダー: 設定フォルダーを WSL と共有している場合(`AIAND_CONFIG_DIR=/mnt/c/Users/<you>/.config/aiand`)、Windows でサインインしたあとに WSL で `aiand status` を実行すると、キーが Windows DPAPI で保存されているのでもう一度サインインするよう表示され、プロセスは起動されません。
9. 展開先にサードパーティの EDR がある場合は、それでも 2 と 3 を繰り返します。

手順 2 または 6 で検知された場合は、リリースを保留してください。コードを変更する前に、上記のコマンドラインを許可リストへ登録することについて、セキュリティチームと相談してください。
