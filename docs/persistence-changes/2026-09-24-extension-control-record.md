---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-24-extension-control-record

English | [中文](2026-09-24-extension-control-record.zh.md)

## Summary

Adds a namespaced, log-only extension record for external Session controllers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing Sessions have no extension records and replay unchanged. The new event has no implicit model-history effect. A Session containing one can execute only while a compatible namespace and schema-version reader is registered; removing that reader refuses resume and the next step before pending input is claimed.

<a id="verification"></a>
## Verification

Host strict typecheck passed. Two focused agent-loop tests covered compatible and missing readers on resume and reader removal before the next step. The Supervisor kernel tests exercised persistence, manual recovery, and bounded reviewer reads.

<a id="dev-note"></a>
## Dev Note

None.
