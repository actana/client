---
"@actana/sdk": minor
---

Pairing stores now charge an attempt only when the code does not match. `claimAttempt` still reserves an attempt so the cap holds under races, and the new `PairingStore.releaseAttempt` hands it back when the code matches, so a right code after four wrong ones pairs and a right code with a bad CSR costs nothing. Custom `PairingStore` implementations must add `releaseAttempt`.
