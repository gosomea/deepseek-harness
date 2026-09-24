---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-24-extension-control-record

[English](2026-09-24-extension-control-record.md) | 中文

## 概述

增加供外部会话控制器使用的命名空间日志事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-24-extension-control-record
baseline: false
changes:
  - root: "event:extension/record"
    previous: null
    after: "3ea023247dcfefb2ebe34274305529315a2099dd71c9edee9486ad72548581fa"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

旧 Session 不含此事件，重放行为不变。新事件本身不会进入模型历史。含有该事件的 Session 只有在对应命名空间及 schema 版本的读取器已注册时才可执行；移除读取器后，恢复和下一步会在领取待处理输入之前被拒绝。

<a id="verification"></a>
## 验证

宿主严格类型检查通过。两项 agent-loop 定向测试覆盖兼容及缺失读取器的恢复，以及下一步前移除读取器。Supervisor 内核测试覆盖持久化、手动恢复与有界审查证据读取。

<a id="dev-note"></a>
## 开发备注

无。
