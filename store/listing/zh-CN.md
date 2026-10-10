# 商店页面 — 简体中文 (zh-CN) · 草稿

> 适用于 Microsoft Store 版。粘贴前请在 Partner Center 中确认各字段的长度限制。
> 不得暗示获得 Anthropic 认可。其他公司的产品名称只能出现在说明文字中，用来说明
> 本应用与什么配合使用；绝不能用在产品名称或搜索词中。

## 应用名称

LHP Local Session Manager *（使用在 Partner Center 中保留的确切名称）*

## 简短说明

非官方本地工具，用于浏览、搜索和导出存储在你电脑上的 AI 编程会话历史，并安全
清理仅有会话记录的本地会话。可处理 Claude Code 和 Claude Desktop 的会话文件。
与 Anthropic 无关。

## 说明

LHP Local Session Manager 是一款独立的非官方 Windows 桌面工具。它会找到
Claude Code 和 Claude Desktop 保存在你电脑上的会话文件，并以快速、可搜索的列表
显示，清晰呈现标题、项目、日期、大小以及每个会话对应的确切文件。

一切都在本地完成。本应用没有账户、没有服务器，不会将会话内容发送到任何地方，
也不收集遥测数据。

本应用处理的是电脑上已有的会话文件。它不是 AI 助手，不包含 Claude Code 或
Claude Desktop，也不会创建会话。如果电脑上没有这类文件，列表为空。

你可以：
• 浏览并查看本地会话：标题、项目、模型、消息数量、文件和大小。
• 按标题、提示词、项目、路径或会话 ID 搜索并整理会话历史，可按日期或项目分组。
• 将会话导出为 JSONL、JSON 或可读的 Markdown。
• 在管理器中隐藏会话，不修改任何会话文件。
• 通过受保护的删除计划，安全删除仅有会话记录的本地会话。
• 查看哪些项目和会话占用的磁盘空间最多。

清理操作以安全为前提设计：
• 应用始终以安全模式启动，此时无法删除任何内容。
• 必须在本次运行中输入 ENABLE DELETE 才能启用永久删除，删除一次或 10 分钟后
  自动关闭。
• 每次删除都会显示将删除和不会删除的确切文件计划，并需要输入确认。
• 正在被运行中的程序打开的会话无法更改。
• 你的项目文件夹永远不会被触碰。

Microsoft Store 版的限制：
带有 Claude Desktop 元数据的会话只能查看和导出，不能归档、恢复或删除。Windows
应用商店的打包机制会隔离部分 AppData 写入，因此此版本不会更改 Claude Desktop
的数据。

非官方本地工具。与 Anthropic 无关，未获得 Anthropic 认可或赞助。
"Claude" 是 Anthropic 的商标。

## 产品功能

- 浏览并查看本地会话
- 搜索并整理本地会话历史
- 按日期或项目分组；按日期、标题或大小排序
- 会话详情：标题、ID、模型、消息数量、文件和大小
- 将本地会话数据导出为 JSONL、JSON 或 Markdown
- 在管理器中隐藏会话
- 安全删除受支持的、仅有会话记录的本地会话
- 受保护的删除计划与工作区校验
- 默认安全模式；删除需先启用并确认
- 存储概览：最大的项目和会话
- 界面支持 English、Tiếng Việt 和简体中文

## 搜索词

- 会话管理
- 本地会话
- 开发者工具
- 记录查看
- 会话清理
- 存储管理
- 桌面工具

## 类别

Developer tools（开发者工具）

## 新增内容（每个版本）

首次在商店发布时留空。之后的版本：版本 X.Y.Z：…

## 版权和商标

© 2026 La Hieu Phong 及贡献者。非官方；与 Anthropic 无关。
"Claude" 是 Anthropic 的商标。

## 链接（Properties 页面）

- 隐私政策 URL：https://lahieuphong.github.io/claude-local-session-manager/privacy/
- 网站：https://lahieuphong.github.io/claude-local-session-manager/
- 支持联系方式：https://github.com/lahieuphong/claude-local-session-manager/issues
