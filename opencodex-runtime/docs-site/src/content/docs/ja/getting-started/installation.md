---
title: インストール
description: Remodex プロキシと前提条件をインストールし、正常に実行できるか確認します。
---

:::note
初期状態では、Remodex は Codex の config.toml、モデル一覧、チャット履歴を変更しません。スマートフォンのペアリング、起動、更新は変更の許可にはなりません。以下の Codex ファイルの同期・書き込み・復元の説明は、ユーザーが rmx sync --allow-config-change で明示的に許可した場合にのみ適用されます。rmx sync --revoke-config-access で許可を取り消しても、既存のファイルは変更されません。

[Codex configuration permission](/reference/cli/lifecycle/#codex-configuration-permission)
:::


Remodex をインストールすると、正規コマンド `rmx` が提供されます。互換性のため `remodex`、`ocx`、`opencodex` も残り、
4 つとも同じ Bun ベースの小さなローカル HTTP サーバーを実行します。モデルリクエストはルーティングで選ばれたプロバイダーに
転送され、必要に応じて vision とウェブ検索のサイドカーが ChatGPT ログインを使うこともあります。

## 前提条件

| 要件 | 理由 |
 --- | --- |
| **[Node](https://nodejs.org) ≥ 20.9** | `rmx` は Bun ランタイムで実行されますが、ランタイムは `npm install` 時に自動でバンドルされるため、Bun を自分でインストールする必要は**ありません**。 |
| **[OpenAI Codex](https://openai.com/codex)**(CLI、App、または SDK) | Remodex が前に立つクライアントです。Remodex は `$CODEX_HOME/config.toml`(デフォルト `~/.codex/config.toml`)に書き込みます。 |
| プロバイダーアカウントまたは API キー | Anthropic、xAI、Kimi、Ollama Cloud、OpenRouter、OpenAI API キー、OpenAI 互換エンドポイント、または ChatGPT ログイン。 |

## インストール

```bash
npm install -g @remodex/rmx
```

:::note[npm が bun の postinstall をブロックした?]
最新の npm は bun の postinstall スクリプトをブロックすることがあります(`npm warn
install-scripts ... blocked because they are not covered by allowScripts`)。
この場合バンドル Bun ランタイムが準備されないため、bun スクリプトを許可して
再インストールしてください。npm 警告の省略コマンドにはパッケージ名が含まれておらず、現在の
ディレクトリを再インストールしてしまうので、必ずパッケージ名を明示してください:

```bash
npm install -g --allow-scripts=bun @remodex/rmx

# 最初に sudo でインストールした場合は sudo を維持してください:
sudo npm install -g --allow-scripts=bun @remodex/rmx
```
:::

正規コマンドが `PATH` にあることを確認します:

```bash
rmx --version
```

`remodex`、`ocx`、`opencodex` は同等の互換エイリアスとして残ります。

インストール後の通常のセットアップは、次の 1 コマンドで完了します:

```bash
rmx onboard
```

`rmx onboard` はコンピューターを準備し、Remodex とゲートウェイを起動して、設定済みのトンネルを自動的に準備します。既定では、リモート接続の検証後にローカルとリモートの両方のアドレスを含む QR が表示されます。同じ信頼できる Wi-Fi を使う場合は「同じ Wi-Fi 用の QR を使う」で先に接続できます。リモート接続が失敗しても、このローカル接続は利用できます。別のネットワークでローカル専用コードを読み取った場合は、検証後の新しい QR を再度読み取ってください。電話はローカル接続に失敗するとリモート接続を試み、携帯回線ではリモート接続を優先する場合があります。

既存のプロバイダー、連携設定、独自ドメインは保持されます。Codex 設定の変更、更新の修復、Windows トレイの導入はペアリングを妨げません。任意の操作は **Android Remote → 詳細設定** にあります。Windows のバックグラウンドタスク初回導入時は管理者の承認が必要な場合があります。QR コードは 5 分で失効し、再作成できます。

### 配布チャネル

安定チャネルの `latest` にも ChatGPT、OpenAI API キー、OpenRouter、実験段階の Cursor 経路のための
GPT-5.6 Sol/Terra/Luna カタログ情報がすでに含まれています。ただしモデルの利用権まで付与されるわけでは
ありません。まだ正式配布されていない Remodex ビルドを試す場合のみ preview チャネルを使ってください:

```bash
npm install -g @remodex/rmx@preview
rmx update --tag preview
```

## ソースから実行

Remodex 自体を直接修正しながら作業するには:

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun install
bun run dev:proxy   # 開発モードでプロキシ API を起動 (src/cli/index.ts start)
bun run dev:gui     # ダッシュボード dev サーバーを起動 (別ターミナル)
```

`bun run dev` は `bun run dev:proxy` のエイリアスとして残っています。プロキシ API は `/healthz`、
`/v1/responses`、`/api/*` を公開し、`GET /` は `bun run build:gui` が `gui/dist` を生成した
後にのみパッケージされたダッシュボードを提供します。ダッシュボードを編集する際は `bun run dev:gui` でフロントエンドを
別途実行してください。

## 生成されるもの

Remodex の状態ファイルは `$OPENCODEX_HOME`(デフォルト `~/.remodex`)の下に、Codex 連携ファイルは
`$CODEX_HOME`(デフォルト `~/.codex`)の下に保存されます。

| パス | 用途 |
 --- | --- |
| `$OPENCODEX_HOME/config.json` | プロバイダー、デフォルトプロバイダー、ポート、オプション。 |
| `$OPENCODEX_HOME/ocx.pid` | 実行中のプロキシの PID(単一インスタンスガード)。 |
| `$OPENCODEX_HOME/runtime-port.json` | 自動で選んだ代替ポートを含む現在の PID、ホスト名、ポート。 |
| `$OPENCODEX_HOME/auth.json` | 保存された OAuth 認証情報(`rmx login` 時)。 |
| `$OPENCODEX_HOME/catalog-backup*.json` | Remodex が変更する前に作成した Codex モデルカタログのバックアップ。 |
| `$CODEX_HOME/config.toml` | ローカル専用構成では Remodex が管理するルート `openai_base_url` を追加します。ローカル以外のアドレスにバインドする場合は Codex が API 認証ヘッダーを送れるよう `model_provider = "opencodex"` と `[model_providers.opencodex]` を使います。 |
| `$CODEX_HOME/opencodex.config.toml` | デフォルト Codex 設定と一緒に生成される参考用 fallback プロファイル。 |
| `$CODEX_HOME/opencodex-catalog.json` | Codex が使うネイティブおよびルーティングモデルカタログ。 |

:::note
Remodex は決して Codex 設定を削除しません。すべての注入は元に戻せます — `rmx stop`、`rmx restore`、
または `rmx eject` は Remodex が追加した行だけを正確に削除し、ネイティブ Codex を復元します。
:::

## 次へ

[クイックスタート](/ja/getting-started/quickstart/)に進んで最初のプロバイダーを設定するか、
アーキテクチャを知るには[仕組み](/ja/getting-started/how-it-works/)をお読みください。
