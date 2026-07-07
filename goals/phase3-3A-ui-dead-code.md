# Goal 3A — UI デッドコード除去 (client UI 単独所有)

**Phase 3 (デッドコード) | 実装: Sonnet | Risk: 低 | Effort: S | upstream_divergence: low**
まず `goals/_CONTEXT.md` を読むこと。

## 目的
未使用の UI コード群 (~2800行) を削除。CoreUI.js/Sidebar.js のデッド参照・コメント・inert state も含め、UI 系デッドコードをこの1タスクに集約してファイル競合を防ぐ ([I2])。

## 対象ファイル (単独所有)
- 削除: `src/client/components/Menu.js`, `MenuApp.js`, `MenuMain.js`, `AppsPane.js`, `Inputs.js`
- 編集: `src/client/components/CoreUI.js`, `src/client/components/Sidebar.js` (import 除去・コメント/inert state 除去)

## やること

### 1. Menu UI 一式削除 (finding 5.3, 2058行)
`Menu.js`(956) / `MenuApp.js`(351) / `MenuMain.js`(328) / `AppsPane.js`(423) は相互 import のみで、CoreUI.js からの参照は全てコメントアウト済み。`MenuMain.js:14` は存在しない `./usePermissions` を import しており re-enable 不可 (bit-rot 済み)。各 MenuItem* primitive は Fields.js の Field* に置換済み。
- 4ファイルを削除。
- `CoreUI.js` の Menu 関連コメントアウト import (`:15-17`) と render コメント (`:103`, `:294-295`) を除去。
- **削除前に必ず `grep -rn "from './Menu'\|MenuApp\|MenuMain\|AppsPane" src` で参照元を全確認**し、コメントアウト以外の live 参照が無いことを確認。

### 2. Inputs.js 削除 (finding 5.4, 516行)
`src/client/components/Inputs.js` (InputText/InputTextarea/... の旧世代 field primitive、Fields.js に置換済み)。`grep -rn "from './Inputs'" src` と各 export 名が自身以外に出現しないことを確認して削除。

### 3. CoreUI/Sidebar のコメント・inert state 除去 (finding 5.5, ~230行)
`src/client/components/CoreUI.js`:
- `:115-327` の ~213行コメントアウト `Side` コンポーネントを削除。
- `:32` の `const [apps, setApps] = useState(false)` と `:41-43`/`:53` の `world.on('apps', setApps)`/`world.off(...)` サブスクリプションを削除 (`emit('apps'` は repo に存在せず永久 inert)。
`src/client/components/Sidebar.js`:
- `:68-70` の未使用 `mainSectionPanes`/`worldSectionPanes`/`appSectionPanes` 定数を削除 (no-unused-vars)。

## やらないこと
- **Sidebar.js の分割 (div:high 5.7) はしない**。上記の定数削除のみ。
- Fields.js を触らない (Phase 4 が所有)。
- live コンポーネント (Chat/Sidebar/CoreUI の実描画部) の挙動を変えない。

## 検証手順
- `grep -rn "from './Menu'\|MenuApp\|MenuMain\|AppsPane\|from './Inputs'" src` が削除後に何も返さないこと。
- `npm run client:build` 成功、`npm run lint` で該当 no-unused-vars が消えること。
- 起動スモーク: Sidebar/CoreUI の描画が従来通り (build モード、チャット、各 pane) であること。
