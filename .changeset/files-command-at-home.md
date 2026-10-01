---
"@actana/sdk": minor
"@actana/cli": minor
---

Add `actana files ls|get|put|rm [<core>:]<path>`, relative to the Core's home folder, and re-address the SDK's Files client at the Core's `/v1/files` routes (control #557). The SDK's `client.project(id)` and `CoreProject` are replaced by `client.files` (`list`, `download`, `upload` and the new `remove`); no Project id is sent anywhere, and `..` or an absolute path is refused before any request. This breaks callers of `client.project(id).files` below 1.0, so both packages are minor; a 0.5.0 Core answers the new routes, a 0.4 Core does not.
