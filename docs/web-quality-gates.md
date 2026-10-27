# Web quality gates

Web の見た目と配信サイズの回帰を CI で検出するための 2 つの gate を説明します。

## Visual regression

`bun run web:visual` は build 済みの Storybook から主要画面の story を light と dark の 2 テーマで screenshot 比較します。CI の job 定義は末尾の付録にあります。

- 対象 story は `web/visual/storybook.visual.spec.ts` の `visualStoryIds` で管理します。
  play function、live data、timer を持たない story だけを追加します。
- 時計は `2026-07-18T02:30:00Z` に固定し、timezone は `Asia/Tokyo`、locale は `ja-JP` です。
- baseline は `web/visual/__screenshots__/` に commit します。
  CI と同じ `mcr.microsoft.com/playwright:v1.60.0-noble` image で描画するため、ローカルの font や renderer の差で失敗しません。
- 1 画像あたり 0.2% までの pixel 差は許容します。

画面を意図して変えた場合は、Docker が使える環境で baseline を更新し、差分画像を確認してから commit します。

```sh
bun run web:build-storybook
bun run web:visual:docker --update-snapshots
```

比較だけを実行する場合は `bun run web:visual:docker` を使います。
CI job では、失敗時に artifact `visual-regression-report` へ期待値・実際・差分の画像を残します。
image は tag と digest の両方で固定しています。`@playwright/test` の version を上げる場合は、`scripts/run-visual-regression-in-container.sh` と workflow の image を同じ version の tag と digest にそろえ、baseline を更新します。

## Performance budget

`bun run web:budget` は `web:build` の出力を検査します。CI では `quality.yml` の `strict-typecheck` job が `web:build` の後に実行します（付録参照）。
`scripts/check-web-bundle-budget.ts` は `web/dist` の各 file を gzip level 9 で計測し、`web/performance-budget.json` と照合します。

- JS と CSS は、必ずいずれかの rule に一致する必要があります。
  rule は上から順に照合し、最初に一致した rule で検査します。
  route の page chunk と共有 chunk は、末尾の `route and shared chunk` rule で 1 file ごとに検査します。
  それ以外の新しい種類の file、たとえば lazy な CSS を作ったときは rule を追加します。
- 初期表示の JS と CSS にも上限があります（`initialJavaScriptAndCssGzipKiB`）。
  対象は build 後の `index.html` が最初の描画前に読む file で、`src` を持つ script、`modulepreload`、stylesheet です。
  page を開いたときに route の `lazy` が読む chunk は含みません。
- JS と CSS の合計にも上限があります。
- 上限は現在の size に約 5% の余裕を足した値です。
  size を減らした場合は上限も下げ、余裕が広がり続けないようにします。

`web/src/app/router.tsx` は、login と 404 以外の page を route の `lazy` で読み込みます。
初期表示の JS と CSS は約 310 KiB gzip で、code splitting 前の約 830 KiB から減りました。
page を分けたぶん、全体の合計は gzip の file ごとの overhead で約 1,320 KiB から約 1,375 KiB に増えています。
新しい page を追加するときは、`lazyPage` で route に登録します。
deploy で chunk が置き換わった後に、開いたままの tab が古い chunk を読めなかった場合は、`web/src/app/staleChunkReload.ts` が page を 1 回だけ再読み込みします。
再読み込みしても読めない場合は、root route の `RouteErrorPage` が再読み込みの操作を表示します。

## 付録: CI workflow

GitHub App から `.github/workflows/` は更新できないため、CI への組み込みは workflow を編集できる maintainer が次の差分を適用します。
適用後は `quality.yml` の strict-typecheck job が budget を、`visual-regression.yml` が screenshot を検査します。

```diff
diff --git a/.github/workflows/quality.yml b/.github/workflows/quality.yml
index 461ff13..1b5beef 100644
--- a/.github/workflows/quality.yml
+++ b/.github/workflows/quality.yml
@@ -44,6 +44,9 @@ jobs:
       - name: Strict typecheck and build Web
         run: bun run web:build
 
+      - name: Check Web performance budget
+        run: bun run web:budget
+
       - name: Strict typecheck and build CDK
         run: bun run cdk:build
 
@@ -83,6 +86,9 @@ jobs:
       - name: Run Web unit tests
         run: bun run web:test
 
+      - name: Test Web performance budget checker
+        run: bun run web:budget:test
+
   web-e2e:
     name: web-e2e
     runs-on: ubuntu-latest
diff --git a/.github/workflows/visual-regression.yml b/.github/workflows/visual-regression.yml
new file mode 100644
index 0000000..199f94d
--- /dev/null
+++ b/.github/workflows/visual-regression.yml
@@ -0,0 +1,68 @@
+name: Visual regression
+
+on:
+  pull_request:
+    paths:
+      - 'web/**'
+      - 'contracts/**'
+      - 'package.json'
+      - 'bun.lock'
+      - 'playwright.visual.config.ts'
+      - 'scripts/serve-static-directory.ts'
+      - '.github/workflows/visual-regression.yml'
+  push:
+    branches:
+      - main
+    paths:
+      - 'web/**'
+      - 'contracts/**'
+      - 'package.json'
+      - 'bun.lock'
+      - 'playwright.visual.config.ts'
+      - 'scripts/serve-static-directory.ts'
+      - '.github/workflows/visual-regression.yml'
+
+concurrency:
+  group: visual-regression-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
+  cancel-in-progress: true
+
+permissions:
+  contents: read
+
+jobs:
+  storybook-visual:
+    name: storybook-visual
+    runs-on: ubuntu-latest
+    timeout-minutes: 20
+    # Baselines in web/visual/__screenshots__ are rendered in this image.
+    container:
+      image: mcr.microsoft.com/playwright:v1.60.0-noble@sha256:9bd26ad900bb5e0f4dee75839e957a89ae89c2b7ab1e76050e559790e946b948
+    steps:
+      - name: Checkout
+        uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
+        with:
+          persist-credentials: false
+
+      - name: Setup Bun
+        uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2
+        with:
+          bun-version: 1.3.10
+
+      - name: Install dependencies
+        run: bun install --frozen-lockfile
+
+      - name: Build Storybook
+        run: bun run web:build-storybook
+
+      - name: Compare Storybook screenshots
+        run: bun run web:visual
+
+      - name: Upload visual diff report
+        if: failure()
+        uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6
+        with:
+          name: visual-regression-report
+          path: |
+            playwright-visual-report/
+            test-results/
+          retention-days: 7
```
