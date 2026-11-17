# C++ 完整引擎逐行除錯功能 — 最終架構規劃文件

> **版本**: v1.3（納入 APCS 完整 STL 清單、串流隔離修復 ＆ 5大介面體驗極致優化）  
> **狀態**: ✅ 架構與 UI 細節全數收斂完畢，待使用者指示即可開始編寫實作  
> **基於**: Gemini + Claude 多輪技術辯論、真實編譯器底層驗證與教學現場 UX 深度調校  

---

## 一、 功能背景與核心目標

### 現有痛點
現行 C++ 執行引擎為純前端輕量直譯器 **JSCPP**，優點是秒速載入、支援逐行除錯與變數視覺化。  
但 JSCPP **不支援 STL 容器**（`<vector>`, `<string>`, `<map>`, `<stack>`, `<queue>` 等），初學者常遭遇：

```
cannot find library: vector
string does not exist
```

學生不知道是「自己語法寫錯」還是「模擬器不支援」，造成困擾與挫折感。

### 核心目標
- 新增「完整 GCC 引擎」選項，支援全部 STL 標頭檔與演算法
- 兩種引擎介面完全一致（同一套六宮格 UI），學生不需重新適應
- 完整 GCC 模式同時支援**逐行除錯 (Step Debug)** 與 **直接執行 (Direct Run)**
- **堅守原則**：要嘛完美逐行除錯，要嘛清楚告知請用本地 IDE，絕不提供半吊子模糊體驗。

---

## 二、 技術方案決策記錄（為何排除其他選項）

| 方案 | 核心問題 | 結論 |
|---|---|---|
| Wasm-Clang (YoWASP) | GAS 環境無法設定 `COOP`/`COEP` Header，`SharedArrayBuffer` 被瀏覽器封鎖 | ❌ 根本不可行 |
| Emscripten 預編譯執行器 | 現有成熟庫皆不提供行級步驟快照，只能看最終輸出 | ❌ 不符合除錯需求 |
| Cloud Run 微服務 | 需綁定 GCP 信用卡、冷啟動 5~8 秒、須自建 Linux 安全沙盒 | ❌ 違反零維護與中學免信用卡原則 |
| Python Tutor C++ API | 未開放 CORS（瀏覽器直接呼叫被封鎖）、個人維護無 SLA、`cin` 支援不穩 | ❌ 不可靠 |
| **GAS 代理 + Wandbox + 前端插樁** | 完全相容 GAS、無需信用卡、Wandbox 10年+ 穩定服務、真 GCC 完整 STL | ✅ **採用（最佳解）** |

---

## 三、 採用架構：GAS 代理 + 前端插樁 + Wandbox 真 GCC

### 3.1 整體流程（逐行除錯路徑 ＆ 輸出串流物理隔離）

```
學生點擊「🔍 進入逐行除錯」（完整 GCC 模式）
        │
        ▼ (前端執行)
[步驟 1] 插樁分析器掃描學生 C++ 原始碼
  - 識別程式碼中的可觀測變數名稱與作用域行號
  - 在每個語句邊界後注入 __trace__(__LINE__, ...) 探針呼叫
  - 最頂部注入「萬能多型序列化標頭」（由 GCC 模板自動推導型別，前端不猜型別）
  - 探針加入 2000 步硬性煞車（防無窮迴圈爆炸）
        │
        ├─ 插樁失敗（遭遇無法解析的底層指標/自訂類別）
        │       ↓
        │   診斷面板顯示具體原因，例如：
        │   「⚠️ 偵測到不支援的語法：指標運算（int* p）
        │      無法產生視覺化除錯。請使用『⚡ 直接執行』或本機 IDE 執行。」
        │   → 流程終止，不提供半吊子除錯
        │
        └─ 插樁成功
                │
                ▼ (呼叫 GAS 後端)
[步驟 2] google.script.run.proxyWandboxCompile(instrumentedCode, stdin)
  - GAS 伺服器端以 UrlFetchApp 發出請求（100% 繞過瀏覽器 CORS 限制）
  - POST https://wandbox.org/api/compile.json
    {
      compiler: "gcc-head",
      code: instrumentedCode,
      stdin: studentInput,
      options: "warning,c++17",
      "compiler-option-raw": "-O0 -g"
    }
        │
        ▼
[步驟 3] 輸出雙串流精準分流解析（關鍵修復！）
  - 學生程式碼原本的 cout 輸出 ➔ 走 program_output (stdout) ➔ 乾淨餵給右側終端！
  - 探針的 steps JSON 記錄 ➔ 走 program_error (stderr) ➔ 乾淨給前端 parseSteps！
  - 徹底避免 cout 輸出與 JSON 追蹤資料混雜造成崩潰！
        │
        ▼
[步驟 4] 灌入現有六宮格 UI（零修改！）
  - 藍紫色行指針 ▶ 逐步推進
  - 右欄變數表（含 vector、set、map、stack 等動態展開）
  - 中斷點 / 自動執行 / 上一步 / 下一步
  - 琥珀金 stdout 最新行高亮
  - Esc 階梯退出除錯
```

### 3.2 整體流程（直接執行路徑，完整 GCC 專屬）

```
學生點擊「⚡ 直接執行 (Run)」（完整 GCC 模式）
        │
        ▼
直接送出原始碼（不插樁），無任何語法限制（含 pointer、struct、class 等）
        │
        ▼ (呼叫 GAS 後端)
google.script.run.proxyWandboxCompile(rawCode, stdin)
        │
        ▼
顯示結果：編譯錯誤至診斷面板，成功輸出完整呈現於右側 stdout 終端
```

---

### 3.3 支援語法範疇（APCS 與中學資訊競賽核心一級支援表）

#### (1) 演算法函式類（100% 完整支援）
全部為正統 GCC `<algorithm>` 與 `<numeric>` 原生函式，執行後於下一行立刻在變數表反映數值更新：
* `sort(a.begin(), a.end())`、`sort(a, a+n, greater<int>())`
* `reverse(a.begin(), a.end())`
* `binary_search(...)`、`lower_bound(...)`、`upper_bound(...)`
* `next_permutation(...)`、`prev_permutation(...)`
* `nth_element(...)`
* `min(...)`、`max(...)`、`abs(...)`、`swap(...)`

#### (2) 容器與資料結構類（變數表視覺化規範）
透過萬能標頭中的模板重載，各容器在右側變數表中的預期呈現樣式：

| 容器 / 資料結構 | 標頭檔 | 變數表呈現樣式 (右欄) | 序列化實作細節 |
| :--- | :--- | :--- | :--- |
| **`int` / `double` / `bool`** | 原生 | 純量徽章：`42`、`3.14`、`true` | 基礎串流輸出 |
| **`string`** | `<string>` | 文字膠囊：`"hello world"` | 帶引號輸出 |
| **`pair<T1, T2>`** | `<utility>` | 雙色徽章：`(10, "apple")` | 讀取 `.first`, `.second` |
| **`vector<T>`** | `<vector>` | 橫向方格列＋長度標籤：`[3, 1, 4, 1, 5] (size: 5)` | 迭代器遍歷 |
| **`set<T>`** | `<set>` | 有序去重集合標籤：`{1, 3, 5} (size: 3)` | 迭代器遍歷 |
| **`map<K, V>`** | `<map>` | 鍵值對網格：`{"a": 1, "b": 2}` | 遍歷每個 `pair` |
| **`bitset<N>`** | `<bitset>` | 二進位字串標籤：`"00101100"` | 呼叫 `.to_string()` |
| **`stack<T>`** | `<stack>` | LIFO 堆疊指示：`[頂: 5 ➔ 3 ➔ 1 :底] (size: 3)` | 副本暫存彈出遍歷 |
| **`queue<T>`** | `<queue>` | FIFO 佇列指示：`[出: 1 ➔ 2 ➔ 3 :入] (size: 3)` | 副本暫存彈出遍歷 |
| **`priority_queue<T>`** | `<queue>` | 優先堆指示：`[頂(最大): 9 ➔ 5 ➔ 2] (size: 3)` | 副本暫存彈出遍歷 |
| **原生陣列 `a[N]` / `a[N][M]`** | 原生 | 1D 索引表 / 2D 矩陣單元格平滑淡出高亮 | 現有反序列化架構 |

#### (3) 插樁器不支援的語法（偵測到時明確拒絕，列出具體原因）

| 偵測到的語法 | 拒絕訊息範例 |
|---|---|
| 指標宣告與算術（`int* p`, `p++`, `*p`） | 「⚠️ 偵測到指標運算（`int* p`），無法於視覺化面板追蹤實體記憶體位址。」 |
| 函式指標（`int (*f)(int)`） | 「⚠️ 偵測到函式指標，視覺化追蹤器不支援。」 |
| Lambda 表達式（`[&](int x){...}`） | 「⚠️ 偵測到 Lambda 表達式，視覺化追蹤器不支援。」 |
| 自訂 class 或 struct（`class Foo`, `struct Bar`） | 「⚠️ 偵測到自訂結構體/類別，無法自動展開未知成員變數。」 |
| 動態配置（`new`, `malloc`, `delete`） | 「⚠️ 偵測到手動記憶體配置（`new`），視覺化追蹤器不支援。」 |

> [!TIP]
> 偵測到不支援語法時，訊息末尾統一引導：  
> **「逐行除錯不支援此進階語法。若需執行，可改用『⚡ 直接執行 (Run)』查看輸出結果，或使用本機 IDE（VS Code / Dev-C++ / Code::Blocks）進行完整除錯。」**

---

## 四、 UI / UX 設計規範 ＆ 5 大體驗優化

### 4.1 優化 1：語言選單膠囊的「小螢幕防擠壓」與「微型滑動膠囊」

```
排版樣式：
[ 🐍 Python (Pyodide) ]  |  [ ⚡ C++   ·輕量·  完整 ]
         ↑ 置中膠囊，嚴格雙鍵等寬對稱主體不動 ↑
                               ↑ C++ 按鈕內部微型切換標籤 (Engine Pill) ↑
```

* **維持嚴格幾何對稱**：兩個主按鈕（Python / C++）的寬度（`w-[145px] sm:w-[180px]`）、中心垂直對齊線完全不動。
* **防誤觸與小螢幕自適應**：
  * 在 C++ 按鈕內，配置深色微光的 Segmented Pill：`[ ·輕量· | 完整 ]`。
  * 點擊 Pill 採用 `@click.stop="toggleCppEngine"`，切換引擎而不觸發切換語言。
  * 點擊 C++ 按鈕本體其他區域，正常執行語言切換。
  * 頂部與提示條的狀態 **100% 雙向即時同動**。

### 4.2 優化 2：C++ 提示條「情境感知雙態配色 (Contextual Tinting)」

提示條在切換引擎時提供醒目的背景色與語意變換，給予強烈的「引擎升級」安全感：

* **⚡ 輕量模式 (JSCPP) —— 警戒琥珀金**：
  * 樣式：`bg-amber-950/40 border-amber-800/40 text-amber-300/90`
  * 內容：`⚠️ 輕量模式 (JSCPP)：支援基礎語法。不支援 vector/string 等 STL？`
  * 動作按鈕：科技藍膠囊 **`[ 🚀 切換至完整 GCC 逐行除錯 ]`**
* **🚀 完整 GCC 模式 (Wandbox) —— 科技藍紫光**：
  * 樣式：`bg-indigo-950/40 border-indigo-800/40 text-indigo-300/90`
  * 內容：`🚀 完整 GCC 模式 (Wandbox)：支援 vector / set / map 等全部 STL ｜ 逐行除錯 ~0.8s`
  * 動作按鈕：暗色膠囊 **`[ ⚡ 切回輕量模式 ]`**

### 4.3 優化 3：右下角「除錯中按鈕」的 0.8s 感知等待設計 (Loading State)

* **痛點防範**：完整 GCC 模式需約 0.6~0.8 秒網路與編譯往返，避免學生誤以為沒反應連續狂點。
* **按鈕狀態機**：
  1. 學生點擊「🔍 進入逐行除錯」瞬間，按鈕轉為：**`[ ⏳ GCC 編譯分析中... ]`**。
  2. 套用 `animate-pulse` 呼吸微光與 `disabled:pointer-events-none` 鎖定。
  3. 資料回傳後，以 `0.22s` 平滑淡入展開六宮格除錯面板。

### 4.4 優化 4：除錯介面頂部「引擎識別徽章 (Engine Badge)」

進入逐行除錯後，在六宮格控制面板的頂部資訊列（Row 1）：
* **輕量版**：`執行步驟: 3 / 15 ｜ [⚡ JSCPP] ● 逐步追蹤中`
* **完整版**：`執行步驟: 3 / 15 ｜ [🚀 GCC 13.2] ● 逐步追蹤中`
* **教學效益**：老師在教室巡堂看學生螢幕時，遠遠一眼即可辨識學生目前背後跑的是輕量直譯器還是正統 GCC。

### 4.5 優化 5：右欄變數表「STL 容器專屬視覺化排版」

* **`vector` / `set`**：在容器名稱右側標註元素數量 `(size: N)`，下方橫向方格排列。
* **`stack` (堆疊)**：標示 `st (size: N)`，下方呈現 `[ 頂端 ▶ 10 ➔ 20 ➔ 30 (底) ]`，生動呈現 LIFO（後進先出）特性。
* **`queue` (佇列)**：標示 `q (size: N)`，下方呈現 `[ 出口 ◀ 1 ➔ 2 ➔ 3 ◀ 入口 ]`，生動呈現 FIFO（先進先出）特性。
* **`pair`**：呈現雙色徽章 `{ first: 10, second: "apple" }`。

### 4.6 智慧引導（JSCPP 報錯時自動提示）

當 JSCPP 在輕量模式執行時，若錯誤訊息包含 `cannot find library`, `vector`, `string`, `map`, `stack` 等關鍵字，診斷面板自動在錯誤訊息下方浮現提示：
> 💡 *此程式碼使用了 STL 函式庫，輕量模式不支援。*  
> **`[ 🚀 一鍵切換至完整 GCC 逐行除錯 ]`**

### 4.7 題庫卡片彈窗與沙盒介面 100% 同動

依 README §7 規範，題庫卡片彈窗（`activeProblem`）與自由練習沙盒（`showSandboxModal`）兩者介面完全一致，同步具備引擎切換開關、提示條與完整除錯能力。

---

## 五、 修改範圍規劃

### 5.1 `Code.gs` 後端新增函式（約 25 行）

```javascript
// 新增：Wandbox GCC 編譯代理（繞過前端 CORS 限制）
function proxyWandboxCompile(code, stdinInput) {
  const payload = {
    compiler: 'gcc-head',
    code: code,
    stdin: stdinInput || '',
    options: 'warning,c++17',
    'compiler-option-raw': '-O0 -g'
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  try {
    const response = UrlFetchApp.fetch('https://wandbox.org/api/compile.json', options);
    return JSON.parse(response.getContentText());
  } catch (e) {
    return { error: 'Wandbox 連線失敗：' + e.message };
  }
}
```

### 5.2 `Index.html` 前端核心函式與狀態

1. **新增狀態**：`cppEngine = ref('jscpp')`、`gccCompiling = ref(false)`。
2. **新增頂層純函式 `instrumentCppCode(rawCode)`**：
   * 注入 C++17 萬能序列化標頭（包含 vector, set, map, stack, queue, pair 格式化）。
   * 探針輸出導向 `std::cerr`（stderr 物理分流）。
   * 加入 2000 步熔斷煞車。
3. **新增 `prepareGccDebugTrace(code, stdin)`**：呼叫後端、解析 `program_error` 產生 steps JSON、灌入現有六宮格面板。
4. **新增 `runGccDirect(code, stdin)`**：直接執行原始碼、輸出結果至右上終端。
5. **UI 修改**：C++ 按鈕微型切換 Pill、提示條情境雙態切換、除錯按鈕 Loading 態、狀態列 GCC 徽章。

### 5.3 修改必須同步的兩個位置（README §7 規範）

| 修改項目 | 沙盒 (`showSandboxModal`) | 題庫彈窗 (`activeProblem`) |
|---|---|---|
| Vue 狀態 `cppEngine` | ✅ 新增 | ✅ 新增（獨立 ref） |
| 語言按鈕引擎 Pill | ✅ | ✅ |
| C++ 提示條情境雙態 | ✅ | ✅ |
| 智慧引導切換按鈕 | ✅ | ✅ |
| GCC 逐行除錯呼叫 | ✅ | ✅ |
| GCC 直接執行呼叫 | ✅ | ✅ |

---

## 六、 品質門禁（強制執行）

每次編輯 `Index.html` 後，必須執行 WebKit 原生 `jsc` 靜態語法檢驗，通過後方可提交：

```bash
python3 -c '
import re, subprocess
with open("Index.html") as f: c = f.read()
assert c.count("<html") == c.count("</html>") == 1
assert c.count("<script") == c.count("</script>")
scripts = re.findall(r"<script(?:\s+[^>]*)?>(.+?)</script>", c, re.DOTALL)
with open("/tmp/__v_syntax.js", "w") as f:
    f.write("try { new Function(" + repr(scripts[-1]) + "); print(\"JS_SYNTAX_VALID\"); } catch(e) { print(\"JS_SYNTAX_ERROR: \" + e.message); }")
res = subprocess.run(["/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc", "/tmp/__v_syntax.js"], capture_output=True, text=True)
assert "JS_SYNTAX_VALID" in res.stdout, f"JavaScript Syntax Check Failed: {res.stdout}"
print("Code Quality Guard Passed: 100% Valid!")
'
```

---

## 七、 實作執行順序

1. 於 `Code.gs` 加入 `proxyWandboxCompile()` 函式。
2. 於 `Index.html` 頂層封裝 `instrumentCppCode()` 萬能序列化與探針注入函式。
3. 於 `Index.html` 封裝 `prepareGccDebugTrace()` 與 `runGccDirect()`。
4. 修改自由沙盒 UI（C++ 按鈕引擎 Pill、情境雙態提示條、除錯按鈕 Loading 態）。
5. 同步修改題庫卡片彈窗 UI 與事件分派（確保兩處一致）。
6. 擴充變數表 STL 容器渲染器（stack/queue/vector 專屬排版與頂部徽章）。
7. 執行 `jsc` 品質門禁語法檢驗。
8. 部署與功能測試。
