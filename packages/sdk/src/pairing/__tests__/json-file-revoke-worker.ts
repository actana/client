import { createJsonFilePairingStore } from "../stores/json-file.ts";

const filePath = process.env.PAIRING_FILE;
const certSerial = process.env.PAIRING_SERIAL;
const at = process.env.PAIRING_AT;

if (!filePath || !certSerial || !at) {
  console.error("PAIRING_FILE, PAIRING_SERIAL, and PAIRING_AT are required");
  process.exit(2);
}

createJsonFilePairingStore(filePath)
  .revoke({ kind: "client", certSerial, at: Number(at) })
  .then((result) => {
    if (!result.ok) {
      console.error("revoke failed:", result);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
