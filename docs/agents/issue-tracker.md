# Issue tracker：GitHub

這個 repo 的 issue 和 PRD 以 GitHub issue 的形式存放。所有操作都用 `gh` CLI。

## 慣例

- **開 issue**：`gh issue create --title "..." --body "..."`。多行內文用 heredoc。
- **讀 issue**：`gh issue view <number> --comments`，用 `jq` 篩留言，順便把標籤也抓回來。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，再加上適當的 `--label` 和 `--state` 篩選。
- **在 issue 上留言**：`gh issue comment <number> --body "..."`
- **貼上／拿掉標籤**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **關閉**：`gh issue close <number> --comment "..."`

repo 從 `git remote -v` 推斷就好——在 clone 裡面跑時，`gh` 會自動處理。

## 把 pull request 當成 triage 入口

**把 PR 當成需求入口：否。** _（如果這個 repo 把外部 PR 當成功能請求，就設成 `yes`；`/triage` 會讀這個開關。）_

設成 `yes` 時，PR 會走跟 issue 一樣的標籤和狀態，改用 `gh pr` 的對應指令：

- **讀 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出要 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，然後只留 `authorAssociation` 是 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、或 `NONE` 的（把 `OWNER`/`MEMBER`/`COLLABORATOR` 丟掉）。
- **留言／標籤／關閉**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用同一組編號，所以單獨一個 `#42` 有可能是其中任一種——先用 `gh pr view 42` 試，失敗再退回 `gh issue view 42`。

## 當某支技能說「發布到 issue tracker」

開一個 GitHub issue。

## 當某支技能說「把相關的 ticket 拿出來」

跑 `gh issue view <number> --comments`。

## Wayfinding 操作

給 `/wayfinder` 用。**地圖（map）**是單獨一個 issue，底下掛**子（child）**issue 當 ticket。

- **地圖**：單獨一個貼上 `wayfinder:map` 的 issue，內文照 wayfinder 的地圖本體模板（目的地／備註／目前的決策／尚未具體化／不在範圍內）填寫。`gh issue create --label wayfinder:map`。
- **子 ticket**：以 GitHub sub-issue 的方式掛到地圖上的 issue（對 sub-issues 端點呼叫 `gh api`）。如果沒開 sub-issues，就把子項加進地圖內文的 task list，並在子項內文頂端放 `Part of #<map>`。標籤：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。一被認領，這張 ticket 就指派給負責推進的開發者。
- **阻塞（Blocking）**：用 GitHub 的**原生 issue 相依性**——這是正規、UI 上看得到的表示法。用 `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>` 加一條邊，其中 `<blocker-db-id>` 是阻塞者的數字型**資料庫 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，**不是** `#number`、也不是 `node_id`）。GitHub 會回報 `issue_dependencies_summary.blocked_by`（只算沒關掉的阻塞者——這就是即時的閘門）。沒辦法用相依性的地方，退回子項內文頂端的一行 `Blocked by: #<n>, #<n>`。等每個阻塞者都關掉，這張 ticket 才解除阻塞。
- **邊界查詢（Frontier query）**：列出地圖底下還沒關的子項（`gh issue list --state open`，範圍限定在地圖的 sub-issues／task list），把任何還有阻塞者沒關的（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 那行裡有沒關的 issue）或已經有人認領的丟掉；地圖順序最前面的勝出。
- **認領（Claim）**：`gh issue edit <n> --add-assignee @me`——這個工作階段的第一筆寫入。
- **解決（Resolve）**：`gh issue comment <n> --body "<答案>"`，接著 `gh issue close <n>`，然後把一個情境指標（gist 加連結）接到地圖的 Decisions-so-far。
