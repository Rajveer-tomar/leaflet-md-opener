# Diagrams

Any fenced code block tagged `mermaid` is drawn as a diagram. Diagrams follow the
current theme, so they stay readable in the dark themes too.

## Sequence

```mermaid
sequenceDiagram
    participant You
    participant Editor
    participant Disk
    You->>Editor: Type some markdown
    Editor-->>You: Preview updates live
    You->>Editor: Ctrl+S
    Editor->>Disk: Save (only if unchanged on disk)
    Disk-->>Editor: OK
```

## Timeline

```mermaid
gantt
    title Writing a README
    dateFormat  YYYY-MM-DD
    section Draft
    Outline        :done,    a1, 2026-10-01, 2d
    First pass     :active,  a2, after a1, 3d
    section Polish
    Screenshots    :         a3, after a2, 1d
    Publish        :         a4, after a3, 1d
```

## Pie

```mermaid
pie title Where the time goes
    "Writing" : 55
    "Editing" : 30
    "Formatting" : 15
```

Back to [the welcome page](welcome.md#things-to-try).
