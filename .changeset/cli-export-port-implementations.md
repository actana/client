---
"@actana/cli": patch
---

Export the runtime port implementations `entry.ts` binds from the package root, so a host can build a complete `ClientDeps` without copying client code: `probeCore`, `connectCore`, `sdkCorePairing`, `openSessionGateway`, `openCoreShell`, `openSessionAttach`, `openSharedThroughCore`, `openFilesAtHome`, `terminalFromProcess` and `nodeClientPrompts`. Until now only their types were exported, and the package exports map has only the root. No behaviour changes.
