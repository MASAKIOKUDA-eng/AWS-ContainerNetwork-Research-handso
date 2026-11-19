# Deploy history

One line per `npm run deploy` / `npm run destroy`.

| UTC | commit | region | command | result | duration | log |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-19T09:51:03Z | `061c1ee` | ap-northeast-1 | deploy   | failed (exit 1) | 46s | 20261119T095103Z.log |
| 2026-11-19T10:19:51Z | `100c25a` | ap-northeast-1 | deploy   | failed (exit 1) | 20s | 20261119T101951Z.log |
| 2026-11-19T10:20:33Z | `100c25a` | ap-northeast-1 | deploy   | failed (exit 1) | 18s | 20261119T102033Z.log |
| 2026-11-19T10:22:04Z | `b9f4f92` | ap-northeast-1 | deploy   | success | 575s | 20261119T102204Z.log |
| 2026-11-19T10:52:51Z | `b9f4f92` | ap-northeast-1 | destroy | success | 987s | - |
| 2026-11-19T10:54:26Z | `b9f4f92` | ap-northeast-1 | deploy   | success | 852s | 20261119T105426Z.log |
| 2026-11-19T12:25:32Z | `10f693c` | ap-northeast-1 | deploy   | success | 26s | 20261119T122532Z.log |
| 2026-11-19T12:58:57Z | `10f693c` | ap-northeast-1 | deploy -c latticeAuthMode=iam-required  | success | 27s | 20261119T125857Z.log |
| 2026-11-19T13:01:04Z | `607af47` | ap-northeast-1 | deploy -c latticeAuthMode=iam-required  | failed (exit 1) | 21s | 20261119T130104Z.log |
| 2026-11-19T13:02:32Z | `607af47` (uncommitted changes) | ap-northeast-1 | deploy -c latticeAuthMode=iam-required  | success | 19s | 20261119T130232Z.log |
| 2026-11-19T13:31:05Z | `607af47` | ap-northeast-1 | destroy | success | 991s | - |
